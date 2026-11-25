import { browser } from 'wxt/browser';
import type { QueueItem } from '../utils/types';

const MAX_CONCURRENT = 3;
const IMAGES_PER_SCENE = 2;        // Flow generates this many images per prompt
const INJECT_DELAY_MS = 15_000;    // 15s between injections → max 4 prompts/min = 8 images/min (rate limit)
const RATE_LIMIT_COOLDOWN_MS = 60_000; // 60s pause when rate limit error is detected

let queue: QueueItem[] = [];
let downloadedTileIds = new Set<string>();
let isInjecting = false;
let pollingInterval: any = null;
let activeTabId: number | null = null;
let rateLimitCooldownUntil = 0; // timestamp — no new injections before this

// mediaId (= data-tile-id in DOM) → { sceneNumber, imageIndex }
const mediaIdToScene = new Map<string, { sceneNumber: number; imageIndex: number }>();

export default defineBackground(() => {
  console.log('Flow Background Queue Orchestrator Started');

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_QUEUE') {
      sendResponse({ queue });
      return true;
    }

    if (message.type === 'START_QUEUE') {
      const { prompts, tabId } = message;
      activeTabId = tabId;

      const newItems: QueueItem[] = prompts.map((p: { scene_number: number; prompt: string }) => ({
        id: Math.random().toString(36).substring(2, 9),
        scene_number: p.scene_number,
        prompt: p.prompt,
        status: 'PENDING',
      }));

      queue = [...queue, ...newItems];
      broadcastQueue();
      initializeKnownIdsAndStart(tabId);
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'CLEAR_QUEUE') {
      queue = [];
      mediaIdToScene.clear();
      downloadedTileIds.clear();
      isInitialized = false;
      isInjecting = false;
      rateLimitCooldownUntil = 0;
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
      activeTabId = null;
      broadcastQueue();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'BATCH_DETECTED') {
      handleBatchResponse(message.data);
      return true;
    }
  });
});

function unwrapTrpc(raw: any): any {
  // tRPC wraps responses: { result: { data: { json: <actual data> } } } or array of such
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const inner = item?.result?.data?.json ?? item?.result?.data;
      if (inner?.workflows || inner?.media) return inner;
    }
  }
  if (raw?.result?.data?.json?.workflows || raw?.result?.data?.json?.media) return raw.result.data.json;
  if (raw?.result?.data?.workflows || raw?.result?.data?.media) return raw.result.data;
  return raw;
}

function handleBatchResponse(raw: any) {
  try {
    const data = unwrapTrpc(raw);
    const workflows: any[] = data?.workflows ?? [];
    const mediaItems: any[] = data?.media ?? [];

    console.log(`[BATCH] response received — ${workflows.length} workflow(s), ${mediaItems.length} media item(s)`);

    for (const workflow of workflows) {
      const workflowId: string = workflow?.name ?? '(no name)';
      const batchId: string | undefined = workflow?.metadata?.batchId;
      const displayName: string | undefined = workflow?.metadata?.displayName;

      console.log(`[BATCH] workflow: ${workflowId}`);
      console.log(`  batchId:     ${batchId ?? '(none — skipping)'}`);
      console.log(`  displayName: ${displayName ?? '(none)'}`);

      if (!batchId) continue;

      // Log all media items that belong to this workflow
      const batchMedia = mediaItems.filter(
        m => m?.image?.generatedImage?.workflowId === workflowId || m?.workflowId === workflowId
      );
      console.log(`  media matched by workflowId: ${batchMedia.length} / ${mediaItems.length}`);
      batchMedia.forEach((m: any, idx: number) => {
        const mediaId = m?.image?.generatedImage?.mediaId ?? m?.name;
        const textInput = m?.image?.generatedImage?.requestData?.promptInputs?.[0]?.textInput;
        console.log(`    [${idx}] mediaId: ${mediaId}, textInput: "${textInput}"`);
      });

      // Match queue item by full prompt text (textInput is the original prompt, displayName is a short summary)
      const promptFromResponse: string | undefined =
        batchMedia[0]?.image?.generatedImage?.requestData?.promptInputs?.[0]?.textInput
        ?? displayName;

      console.log(`  prompt used for matching: "${promptFromResponse}"`);
      console.log(`  queue IN_PROGRESS items:`, queue.filter(q => q.status === 'IN_PROGRESS').map(q => `scene ${q.scene_number} prompt="${q.prompt.slice(0, 40)}""`));

      // Match only by prompt — a scene can receive multiple batch responses (1 per image)
      const target = promptFromResponse
        ? queue.find(q => q.status === 'IN_PROGRESS' && q.prompt === promptFromResponse)
        : undefined;

      if (!target) {
        console.warn(`  [BATCH] no queue match — prompt "${promptFromResponse?.slice(0, 60)}" not found among IN_PROGRESS items`);
        continue;
      }

      console.log(`  [BATCH] matched → scene ${target.scene_number}`);

      // Count images already mapped for this scene to assign the correct imageIndex
      let nextImageIndex = [...mediaIdToScene.values()]
        .filter(v => v.sceneNumber === target.scene_number).length + 1;

      batchMedia.forEach((m: any) => {
        const mediaId: string | undefined = m?.image?.generatedImage?.mediaId ?? m?.name;
        if (mediaId && !mediaIdToScene.has(mediaId)) {
          mediaIdToScene.set(mediaId, { sceneNumber: target.scene_number, imageIndex: nextImageIndex });
          console.log(`    mapped mediaId ${mediaId} → scene ${target.scene_number} img ${nextImageIndex}`);
          nextImageIndex += 1;
        }
      });
    }

    broadcastQueue();
  } catch (e) {
    console.error('[BATCH] error', e);
  }
}

function broadcastQueue() {
  browser.runtime.sendMessage({ type: 'QUEUE_UPDATED', queue }).catch(() => {});
}

let isInitialized = false;

async function initializeKnownIdsAndStart(tabId: number) {
  if (isInitialized) {
    processQueue();
    startPollingIfNeeded();
    return;
  }
  isInitialized = true;

  try {
    const initialResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        Array.from(document.querySelectorAll('[data-tile-id]'))
          .filter(t => {
            const img = t.querySelector('img') as HTMLImageElement;
            return img && img.src && !img.src.includes('data:image');
          })
          .map(el => el.getAttribute('data-tile-id')),
    });

    const initialIds = initialResults?.[0]?.result;
    if (Array.isArray(initialIds)) {
      initialIds.forEach((id: string | null) => { if (id) downloadedTileIds.add(id); });
    }
  } catch (e) {
    console.error('[INIT] error', e);
  }

  processQueue();
  startPollingIfNeeded();
}

async function processQueue() {
  if (isInjecting) return;
  if (activeTabId === null) return;

  // Respect rate limit cooldown
  const now = Date.now();
  if (now < rateLimitCooldownUntil) {
    const remaining = Math.ceil((rateLimitCooldownUntil - now) / 1000);
    console.log(`[RATE LIMIT] cooldown active — ${remaining}s remaining`);
    return;
  }

  const inProgressCount = queue.filter(q => q.status === 'IN_PROGRESS').length;
  if (inProgressCount >= MAX_CONCURRENT) return;

  const nextPending = queue.find(q => q.status === 'PENDING' || q.status === 'RATE_LIMITED');
  if (!nextPending) return;

  isInjecting = true;
  nextPending.status = 'IN_PROGRESS';
  broadcastQueue();

  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      world: 'MAIN',
      func: async (promptText) => {
        // Flow's current generation composer is a ProseMirror textbox. The old
        // data-slate-editor selector no longer exists on the current Flow UI.
        const editorDom = document.querySelector<HTMLElement>(
          '[role="textbox"][contenteditable="true"][aria-label="What do you want to create?"]'
        );

        if (!editorDom) {
          return {
            success: false,
            error: 'Google Flow generation prompt editor was not found. Open a Flow project and make sure the "What do you want to create?" field is visible.',
          };
        }

        editorDom.focus();

        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editorDom);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);

        const beforeInputEvent = new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: promptText,
          bubbles: true,
          cancelable: true,
        });
        editorDom.dispatchEvent(beforeInputEvent);

        if (!beforeInputEvent.defaultPrevented) {
          document.execCommand('insertText', false, promptText);
          editorDom.dispatchEvent(new InputEvent('input', {
            inputType: 'insertText',
            data: promptText,
            bubbles: true,
          }));
        }

        // Allow Flow to update its composer state before submitting.
        await new Promise(resolve => setTimeout(resolve, 800));

        const sendButton = Array.from(document.querySelectorAll('button')).find(button => {
          const icon = button.querySelector('i.google-symbols');
          return icon?.textContent?.trim() === 'arrow_forward';
        });

        if (sendButton) {
          sendButton.click();
        } else {
          // Keyboard submission is a fallback for Flow layouts without the
          // recognizable arrow_forward button.
          editorDom.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }));
        }

        return { success: true, submittedWithButton: Boolean(sendButton) };
      },
      args: [nextPending.prompt],
    });

    const injectionResult = injectionResults?.[0]?.result as
      | { success?: boolean; error?: string; submittedWithButton?: boolean }
      | undefined;

    if (!injectionResult?.success) {
      throw new Error(
        injectionResult?.error ?? 'Google Flow prompt injection did not complete.'
      );
    }

    console.log(
      `[INJECT] scene ${nextPending.scene_number} prompt inserted; submit button: ${injectionResult.submittedWithButton ? 'found' : 'keyboard fallback'}`
    );

    // Keep generations sequential to avoid duplicate requests and Flow rate limits.
    await new Promise(r => setTimeout(r, INJECT_DELAY_MS));
  } catch (e) {
    console.error('[INJECT] error', e);
    nextPending.status = 'ERROR';
  } finally {
    isInjecting = false;
    broadcastQueue();
    // Do NOT call processQueue() here — next injection happens only after
    // the current scene's images are confirmed downloaded in the UI (DOWNLOADED status)
  }
}

function startPollingIfNeeded() {
  if (pollingInterval) return;
  if (activeTabId === null) return;

  pollingInterval = setInterval(async () => {
    const inProgressCount = queue.filter(q => q.status === 'IN_PROGRESS').length;
    if (inProgressCount === 0) {
      clearInterval(pollingInterval);
      pollingInterval = null;
      return;
    }

    if (activeTabId === null) return;

    try {
      const scanResults = await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: () => {
          const tiles: [string, string][] = [];
          const rateLimitTileIds: string[] = [];

          document.querySelectorAll('[data-tile-id]').forEach(t => {
            const id = t.getAttribute('data-tile-id');
            if (!id) return;

            const img = t.querySelector('img') as HTMLImageElement;
            if (img?.src && !img.src.includes('data:image')) {
              tiles.push([id, img.src.startsWith('/') ? location.origin + img.src : img.src]);
              return;
            }

            // Detect rate limit error tiles — look for the error text (robust vs obfuscated class names)
            if (t.textContent?.includes('too quickly')) {
              rateLimitTileIds.push(id);
            }
          });

          return { tiles, rateLimitTileIds };
        },
      });

      const scanResult = scanResults?.[0]?.result;
      if (!scanResult || !Array.isArray(scanResult.tiles) || !Array.isArray(scanResult.rateLimitTileIds)) {
        console.warn('[POLL] Flow tab returned no tile scan result.');
        return;
      }
      const { tiles: currentTiles, rateLimitTileIds } = scanResult as {
        tiles: [string, string][];
        rateLimitTileIds: string[];
      };

      // Handle rate limit errors
      if (rateLimitTileIds.length > 0) {
        console.warn(`[RATE LIMIT] detected ${rateLimitTileIds.length} failed tile(s) — cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s`);
        rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;

        // Mark affected IN_PROGRESS scenes as RATE_LIMITED so they re-enter the queue after cooldown
        const affectedScenes = queue.filter(q => q.status === 'IN_PROGRESS');
        affectedScenes.forEach(q => {
          q.status = 'RATE_LIMITED';
          console.log(`[RATE LIMIT] scene ${q.scene_number} marked as RATE_LIMITED — will retry after cooldown`);
        });

        broadcastQueue();

        // Schedule processQueue to run after cooldown expires
        setTimeout(() => {
          queue.filter(q => q.status === 'RATE_LIMITED').forEach(q => {
            q.status = 'PENDING';
          });
          broadcastQueue();
          processQueue();
        }, RATE_LIMIT_COOLDOWN_MS);
      }

      const newTiles = currentTiles.filter(([id, imgUrl]) => {
        if (downloadedTileIds.has(id)) return false;
        const uuid = imgUrl.match(/[?&]name=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
        if (uuid && downloadedTileIds.has(uuid)) return false;
        return true;
      });

      for (const [tileId, imgUrl] of newTiles) {
        const uuidFromUrl = imgUrl.match(/[?&]name=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];

        // Guard: another tile earlier in this same loop may have already claimed this uuid
        if (downloadedTileIds.has(tileId)) continue;
        if (uuidFromUrl && downloadedTileIds.has(uuidFromUrl)) continue;

        // Flow may expose the generated media ID as the tile ID rather than the URL UUID.
        const mapping = (uuidFromUrl ? mediaIdToScene.get(uuidFromUrl) : undefined)
          ?? mediaIdToScene.get(tileId);

        if (!mapping) {
          console.log(`[POLL] tile ${tileId} | imgSrc: ${imgUrl.slice(0, 100)} | urlUuid: ${uuidFromUrl ?? 'none'} | no mapping yet, waiting`);
          continue;
        }

        downloadedTileIds.add(tileId);
        if (uuidFromUrl) downloadedTileIds.add(uuidFromUrl); // needed for checkSceneComplete lookup
        const paddedScene = mapping.sceneNumber.toString().padStart(2, '0');

        browser.downloads.download({
          url: imgUrl,
          filename: `Flow_Generations/Escena_${paddedScene}/imagen_${mapping.imageIndex}.png`,
          saveAs: false,
        }).catch(err => console.error('[DOWNLOAD] error', err));

        console.log(`[DOWNLOAD] scene ${mapping.sceneNumber} img ${mapping.imageIndex} (tileId: ${tileId} | urlUuid: ${uuidFromUrl})`);

        const sceneItem = queue.find(q => q.scene_number === mapping.sceneNumber && q.status === 'IN_PROGRESS');
        if (sceneItem) {
          const sceneMediaIds = [...mediaIdToScene.entries()]
            .filter(([, v]) => v.sceneNumber === mapping.sceneNumber)
            .map(([k]) => k);

          if (sceneMediaIds.length >= IMAGES_PER_SCENE && sceneMediaIds.every(mid => downloadedTileIds.has(mid))) {
            sceneItem.status = 'DOWNLOADED';
            broadcastQueue();
            processQueue();
          }
        }
      }
    } catch (e) {
      console.error('[POLL] error', e);
    }
  }, 3000);
}
