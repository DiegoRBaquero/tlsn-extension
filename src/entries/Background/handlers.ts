import { getCacheByTabId } from './cache';
import {
  BackgroundActiontype,
  handleProveRequestStart,
  RequestLog,
} from './rpc';
import mutex from './mutex';
import browser from 'webextension-polyfill';
import { addRequest } from '../../reducers/requests';
import bookmarks from '../../../utils/bookmark/bookmarks.json';
import { replayRequest, urlify } from '../../utils/misc';
import { get, NOTARY_API_LS_KEY, PROXY_API_LS_KEY } from '../../utils/storage';

export const onSendHeaders = (
  details: browser.WebRequest.OnSendHeadersDetailsType,
) => {
  return mutex.runExclusive(async () => {
    const { method, tabId, requestId } = details;

    if (method !== 'OPTIONS') {
      const cache = getCacheByTabId(tabId);
      const existing = cache.get<RequestLog>(requestId);
      cache.set(requestId, {
        ...existing,
        method: details.method as 'GET' | 'POST',
        type: details.type,
        url: details.url,
        initiator: details.initiator || null,
        requestHeaders: details.requestHeaders || [],
        tabId: tabId,
        requestId: requestId,
      });
    }
  });
};

export const onBeforeRequest = (
  details: browser.WebRequest.OnBeforeRequestDetailsType,
) => {
  mutex.runExclusive(async () => {
    const { method, requestBody, tabId, requestId } = details;

    if (method === 'OPTIONS') return;

    if (requestBody) {
      const cache = getCacheByTabId(tabId);
      const existing = cache.get<RequestLog>(requestId);

      if (requestBody.raw && requestBody.raw[0]?.bytes) {
        try {
          cache.set(requestId, {
            ...existing,
            requestBody: Buffer.from(requestBody.raw[0].bytes).toString(
              'utf-8',
            ),
          });
        } catch (e) {
          console.error(e);
        }
      } else if (requestBody.formData) {
        cache.set(requestId, {
          ...existing,
          formData: requestBody.formData,
        });
      }
    }
  });
};

export const onCompletedForNotarization = (
  details: browser.WebRequest.OnBeforeRequestDetailsType,
) => {
  mutex.runExclusive(async () => {
    const { method, url, type, tabId, requestId } = details;

    if (tabId === -1) return;

    const bookmark = bookmarks.find(
      (bm) =>
        url.startsWith(bm.url) && method === bm.method && type === bm.type,
    );

    if (bookmark) {
      const cache = getCacheByTabId(tabId);

      const req = cache.get<RequestLog>(requestId);

      if (!req) return;

      const res = await replayRequest(req);
      const secretHeaders = req.requestHeaders
        .map((h) => {
          return `${h.name.toLowerCase()}: ${h.value || ''}` || '';
        })
        .filter((d) => !!d);
      const selectedValue = res.match(
        new RegExp(bookmark.responseSelector, 'g'),
      );

      if (selectedValue) {
        const revealed = bookmark.valueTransform.replace(
          '%s',
          selectedValue[0],
        );
        const selectionStart = res.indexOf(revealed);
        const selectionEnd = selectionStart + revealed.length - 1;
        const secretResps = [
          res.substring(0, selectionStart),
          res.substring(selectionEnd, res.length),
        ].filter((d) => !!d);

        const hostname = urlify(req.url)?.hostname;
        const notaryUrl = await get(NOTARY_API_LS_KEY);
        const websocketProxyUrl = await get(PROXY_API_LS_KEY);

        const headers: { [k: string]: string } = req.requestHeaders.reduce(
          (acc: any, h) => {
            acc[h.name] = h.value;
            return acc;
          },
          { Host: hostname },
        );

        //TODO: for some reason, these needs to be override to work
        headers['Accept-Encoding'] = 'identity';
        headers['Connection'] = 'close';

        await handleProveRequestStart(
          {
            type: BackgroundActiontype.prove_request_start,
            data: {
              url: req.url,
              method: req.method,
              headers: headers,
              body: req.requestBody,
              maxTranscriptSize: 16384,
              secretHeaders,
              secretResps,
              notaryUrl,
              websocketProxyUrl,
            },
          },
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          () => {},
        );
      }
    }
  });
};

export const onResponseStarted = (
  details: browser.WebRequest.OnResponseStartedDetailsType,
) => {
  mutex.runExclusive(async () => {
    const { method, responseHeaders, tabId, requestId } = details;

    if (method === 'OPTIONS') return;

    const cache = getCacheByTabId(tabId);

    const existing = cache.get<RequestLog>(requestId);
    const newLog: RequestLog = {
      requestHeaders: [],
      ...existing,
      method: details.method,
      type: details.type,
      url: details.url,
      initiator: details.initiator || null,
      tabId: tabId,
      requestId: requestId,
      responseHeaders,
    };

    cache.set(requestId, newLog);

    chrome.runtime.sendMessage({
      type: BackgroundActiontype.push_action,
      data: {
        tabId: details.tabId,
        request: newLog,
      },
      action: addRequest(newLog),
    });
  });
};
