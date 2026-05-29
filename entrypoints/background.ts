import { browser } from 'wxt/browser';
import { QueueItem } from '../utils/types';

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

  // Register the MAIN-world injector script (WXT doesn't add it to the manifest automatically)
  chrome.scripting.registerContentScripts([{
    id: 'flow-injector',
    matches: ['*://*.google.com/*', '*://labs.google/*'],
    js: ['injector.js'],
    world: 'MAIN',
    runAt: 'document_start',
  }]).catch(() => {
    // Already registered from a previous session — update it
    chrome.scripting.updateContentScripts([{
      id: 'flow-injector',
      matches: ['*://*.google.com/*', '*://labs.google/*'],
      js: ['injector.js'],
      world: 'MAIN',
      runAt: 'document_start',
    }]).catch(e => console.error('[INJECTOR] update failed:', e));
  });

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
      const alreadyMapped = [...mediaIdToScene.values()]
        .filter(v => v.sceneNumber === target.scene_number).length;

      batchMedia.forEach((m: any, idx: number) => {
        const mediaId: string | undefined = m?.image?.generatedImage?.mediaId ?? m?.name;
        if (mediaId && !mediaIdToScene.has(mediaId)) {
          const imageIndex = alreadyMapped + idx + 1;
          mediaIdToScene.set(mediaId, { sceneNumber: target.scene_number, imageIndex });
          console.log(`    mapped mediaId ${mediaId} → scene ${target.scene_number} img ${imageIndex}`);
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
    const [{ result: initialIds }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        Array.from(document.querySelectorAll('[data-tile-id]'))
          .filter(t => {
            const img = t.querySelector('img') as HTMLImageElement;
            return img && img.src && !img.src.includes('data:image');
          })
          .map(el => el.getAttribute('data-tile-id')),
    });

    if (initialIds) {
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
  if (!activeTabId) return;

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
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      world: 'MAIN',
      func: (promptText) => {
        const editorDom = document.querySelector<HTMLElement>('[data-slate-editor="true"]');
        if (!editorDom) return;
        editorDom.focus();

        const leaf = editorDom.querySelector('[data-slate-leaf="true"]') || editorDom;
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(leaf);
        range.collapse(false);
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }

        const beforeInputEvent = new InputEvent('beforeinput', { inputType: 'insertText', data: promptText, bubbles: true, cancelable: true }) as any;
        beforeInputEvent.getTargetRanges = () => [range];
        editorDom.dispatchEvent(beforeInputEvent);

        if (!beforeInputEvent.defaultPrevented) {
          document.execCommand('insertText', false, promptText);
          editorDom.dispatchEvent(new Event('input', { bubbles: true }));
        }

        setTimeout(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const sendButton = buttons.find(b => {
            const icon = b.querySelector('i.google-symbols');
            return icon && icon.textContent?.trim() === 'arrow_forward';
          });

          if (sendButton) {
            sendButton.removeAttribute('disabled');
            sendButton.removeAttribute('aria-disabled');
            sendButton.style.pointerEvents = 'auto';
            sendButton.click();

            const btnReactKey = Object.keys(sendButton).find(k => k.startsWith('__reactProps$'));
            if (btnReactKey) {
              const props = (sendButton as any)[btnReactKey];
              if (props && typeof props.onClick === 'function') {
                try { props.onClick({ preventDefault: () => {}, stopPropagation: () => {}, nativeEvent: { isTrusted: true } }); } catch {}
              }
            }
          }

          editorDom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));

          const editorReactKey = Object.keys(editorDom).find(k => k.startsWith('__reactProps$'));
          if (editorReactKey) {
            const props = (editorDom as any)[editorReactKey];
            if (props && typeof props.onKeyDown === 'function') {
              try { props.onKeyDown({ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, preventDefault: () => {}, stopPropagation: () => {}, nativeEvent: { isTrusted: true } }); } catch {}
            }
          }
        }, 800);
      },
      args: [nextPending.prompt],
    });

    // Small buffer after injection before allowing another one
    await new Promise(r => setTimeout(r, 2000));
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
  if (!activeTabId) return;

  pollingInterval = setInterval(async () => {
    const inProgressCount = queue.filter(q => q.status === 'IN_PROGRESS').length;
    if (inProgressCount === 0) {
      clearInterval(pollingInterval);
      pollingInterval = null;
      return;
    }

    if (!activeTabId) return;

    try {
      const [{ result: scanResult }] = await chrome.scripting.executeScript({
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

        const mapping = uuidFromUrl ? mediaIdToScene.get(uuidFromUrl) : undefined;

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
