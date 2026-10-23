/**
 * The “Export from YouTube” subscription export.
 *
 * YouTube's `/feed/channels` page renders only the first thousand channels,
 * but its InnerTube continuation still pages through the whole list for a
 * signed-in session. That is what this script uses:
 *
 *  1. It reads `SAPISID` from the page (the session cookie YouTube's own web
 *     client signs requests with; it is not logged or sent anywhere else) and
 *     computes the `SAPISIDHASH` header the same way YouTube's client does.
 *  2. It asks `/youtubei/v1/browse` for the `FEchannels` continuation, page by
 *     page, collecting every `channelRenderer` id and title.
 *  3. If the signed request cannot be made (signed out, a changed endpoint),
 *     it falls back to the old DOM scroll, which still finds the first page.
 *
 * The result is a Takeout-shaped CSV, downloaded locally:
 *
 *   Channel Id,Channel Url,Channel Title
 *   UC…,https://www.youtube.com/channel/UC…,Name
 *
 * Nothing leaves the browser. The number in the tab title, `(7927) All
 * subscriptions`, is the unread notification count: it moves as notifications
 * arrive and has nothing to do with the channel list, so it is never used as
 * the total.
 */

export const SUBS_EXPORT_SCRIPT = `(async () => {
  if (!/(^|\\.)youtube\\.com$/.test(location.hostname) || location.pathname !== "/feed/channels") {
    alert("Open https://www.youtube.com/feed/channels first, signed in.");
    return;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const say = (message) => console.log("[subs-export] " + message);

  const titleOf = (renderer) => {
    const title = renderer && (renderer.title || renderer.formattedTitle);
    if (!title) return "";
    if (title.simpleText) return String(title.simpleText);
    if (Array.isArray(title.runs)) return title.runs.map((run) => run.text || "").join("");
    return "";
  };

  const entries = new Map();
  const add = (id, name) => {
    if (typeof id === "string" && /^UC[\\w-]{20,}$/.test(id)) {
      if (!entries.has(id) || (name && entries.get(id) === id)) entries.set(id, name || id);
    }
  };

  const walk = (value, visit) => {
    if (!value || typeof value !== "object") return;
    visit(value);
    for (const key of Object.keys(value)) walk(value[key], visit);
  };

  // The DOM's first page is a useful seed, and the fallback when the signed
  // request is unavailable. It is collected before paging.
  const collectDom = () => {
    for (const el of document.querySelectorAll("ytd-channel-renderer")) {
      const data = el.data || (el.__data && el.__data.data) || null;
      if (data && data.channelId) add(data.channelId, titleOf(data));
    }
    const app = document.querySelector("ytd-app");
    for (const root of [app && app.data && app.data.response, window.ytInitialData]) {
      walk(root, (node) => {
        const renderer = node.channelRenderer;
        if (renderer && renderer.channelId) add(renderer.channelId, titleOf(renderer));
      });
    }
  };

  const cookie = (name) => {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  };

  const makeAuth = async () => {
    const sapisid = cookie("SAPISID") || cookie("__Secure-3PAPISID") || cookie("__Secure-1PAPISID");
    if (!sapisid || !window.ytcfg) return "";
    const ts = Math.floor(Date.now() / 1000);
    const origin = "https://www.youtube.com";
    const bytes = new TextEncoder().encode(ts + " " + sapisid + " " + origin);
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return "SAPISIDHASH " + ts + "_" + hash;
  };

  const api = (() => {
    if (!window.ytcfg || !ytcfg.get("INNERTUBE_API_KEY")) return null;
    return {
      url: "/youtubei/v1/browse?key=" + encodeURIComponent(ytcfg.get("INNERTUBE_API_KEY")) + "&prettyPrint=false",
      context: ytcfg.get("INNERTUBE_CONTEXT"),
      version: ytcfg.get("INNERTUBE_CLIENT_VERSION"),
      authUser: String(ytcfg.get("SESSION_INDEX") || "0"),
    };
  })();

  collectDom();
  say(entries.size + " channels on the rendered page; asking YouTube for the rest…");

  let complete = false;
  if (api) {
    try {
      // The page's own HTML carries the first continuation tokens.
      const html = await (await fetch("/feed/channels", { credentials: "include" })).text();
      const tokens = [...html.matchAll(/"continuationCommand"\\s*:\\s*\\{\\s*"token"\\s*:\\s*"([^"]+)"/g)].map((m) => m[1]);
      for (const match of html.matchAll(/"channelId"\\s*:\\s*"(UC[\\w-]{20,})"/g)) add(match[1], "");

      let token = tokens[0] || "";
      if (token) {
        const auth = await makeAuth();
        if (auth) {
          const headers = {
            "Content-Type": "application/json",
            "Authorization": auth,
            "X-Goog-AuthUser": api.authUser,
            "X-Origin": "https://www.youtube.com",
            "X-Youtube-Client-Name": "1",
            "X-Youtube-Client-Version": api.version,
          };
          for (let page = 1; page <= 500 && token; page++) {
            const res = await fetch(api.url, {
              method: "POST",
              credentials: "include",
              headers,
              body: JSON.stringify({ context: api.context, continuation: token }),
            });
            if (!res.ok) {
              say("YouTube answered " + res.status + " after " + (page - 1) + " pages.");
              break;
            }
            const json = await res.json();
            let next = "";
            let before = entries.size;
            for (const action of json.onResponseReceivedActions || []) {
              walk(action, (node) => {
                const renderer = node.channelRenderer || node.gridChannelRenderer;
                if (renderer && renderer.channelId) add(renderer.channelId, titleOf(renderer));
                const command = node.continuationItemRenderer &&
                  node.continuationItemRenderer.continuationEndpoint &&
                  node.continuationItemRenderer.continuationEndpoint.continuationCommand;
                if (command && command.token) next = command.token;
              });
            }
            const added = entries.size - before;
            token = next;
            if (!token || added === 0) { complete = true; break; }
            if (page % 10 === 0) say(entries.size + " channels so far (" + page + " pages)…");
            await sleep(80);
          }
        }
      }
    } catch (error) {
      say("InnerTube failed (" + (error && error.message) + "); using the page instead.");
    }
  }

  if (!complete) {
    // Fallback: the rendered page. Older layouts, or a session the API no
    // longer accepts, still get the first thousand.
    say("scrolling the rendered list…");
    const step = Math.max(800, Math.floor(window.innerHeight * 1.5));
    let last = 0;
    let stable = 0;
    for (let round = 1; round <= 400 && stable < 6; round++) {
      window.scrollBy(0, step);
      await sleep(600);
      collectDom();
      if (entries.size === last) stable += 1;
      else { stable = 0; last = entries.size; }
    }
    window.scrollTo(0, 0);
  }

  if (entries.size === 0) {
    alert("No subscriptions found — make sure you are signed in and on youtube.com/feed/channels.");
    return;
  }

  const cell = (value) => {
    const text = String(value == null ? "" : value);
    return /[",\\n\\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  const rows = [["Channel Id", "Channel Url", "Channel Title"]];
  for (const [id, name] of entries) {
    rows.push([id, "https://www.youtube.com/channel/" + id, name]);
  }
  const csv = rows.map((row) => row.map(cell).join(",")).join("\\n") + "\\n";

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "subscriptions.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  say("wrote " + entries.size + " subscriptions to subscriptions.csv");
  alert(
    "Exported " + entries.size + " subscriptions" + (complete ? " — the full list." : " (the first page only).") +
    "\\n\\nNow open the app and press Import CSV / JSON."
  );
})();`;
