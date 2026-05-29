export default defineContentScript({
  matches: ['*://*.google.com/*', '*://labs.google/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    console.log('[FLOW-EXT] Injector running in MAIN world — installing fetch/XHR interceptors');

    // --- Fetch interceptor ---
    const _originalFetch = window.fetch;
    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url ?? '';

      // Log every fetch so we can confirm the interceptor is running
      console.log('[FLOW-EXT] fetch:', url.slice(0, 120));

      const response = await _originalFetch.apply(this, args);

      // Intercept tRPC calls on labs.google that may contain batch/media generation info
      if (url.includes('/fx/api/trpc/') || url.includes('batchGenerateImages')) {
        response.clone().text().then((text: string) => {
          if (!text.includes('batchId') && !text.includes('mediaId')) return;
          console.log('[FLOW-EXT] response with batch/media info from:', url.slice(0, 120));
          console.log('[FLOW-EXT] response body (first 500):', text.slice(0, 500));
          // Try flat JSON first, then NDJSON
          try {
            const data = JSON.parse(text);
            window.postMessage({ type: 'FLOW_BATCH_RESPONSE', data }, '*');
          } catch {
            text.split('\n').filter(l => l.trim()).forEach(line => {
              try {
                const data = JSON.parse(line);
                if (JSON.stringify(data).includes('batchId')) {
                  window.postMessage({ type: 'FLOW_BATCH_RESPONSE', data }, '*');
                }
              } catch {}
            });
          }
        }).catch(() => {});
      }

      return response;
    };

    // --- XHR interceptor ---
    const _originalOpen = XMLHttpRequest.prototype.open;
    const _originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: any[]) {
      (this as any)._flowUrl = url;
      return _originalOpen.apply(this, [method, url, ...rest] as any);
    };

    XMLHttpRequest.prototype.send = function (...args: any[]) {
      if ((this as any)._flowUrl?.includes('batchGenerateImages')) {
        console.log('[FLOW-EXT] batchGenerateImages XHR detected:', (this as any)._flowUrl);
        this.addEventListener('load', function (this: XMLHttpRequest) {
          try {
            const data = JSON.parse(this.responseText);
            console.log('[FLOW-EXT] batchGenerateImages XHR response:', JSON.stringify(data).slice(0, 500));
            window.postMessage({ type: 'FLOW_BATCH_RESPONSE', data }, '*');
          } catch (e) {
            console.warn('[FLOW-EXT] batchGenerateImages XHR response is not JSON:', e);
          }
        });
      }
      return _originalSend.apply(this, args as [body?: Document | XMLHttpRequestBodyInit | null]);
    };

    console.log('[FLOW-EXT] fetch/XHR interceptors installed');
  },
});
