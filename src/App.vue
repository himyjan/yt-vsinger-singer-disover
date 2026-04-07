<script setup lang="ts" vapor>
import { ref, onMounted, computed } from 'vue';

const DARK_KEY = 'yt_sing_dark';
const isDark = ref(false);

const toggleDark = () => {
  isDark.value = !isDark.value;
  try {
    localStorage.setItem(DARK_KEY, isDark.value ? '1' : '0');
  } catch (_) { }
  document.documentElement.classList.toggle('dark', isDark.value);
};

interface Channel {
  id: string;
  name: string;
  handle?: string;
  thumbnail: string;
  thumbnails?: { url: string }[];
  last_synced: number;
  is_collected: number;
}

interface Item {
  id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  type: 'video' | 'playlist';
  thumbnail: string;
  published_at: string;
  is_collected: number;
}

const channels = ref<Channel[]>([]);
const items = ref<Item[]>([]);
const searchResults = ref<any[]>([]);
const stats = ref({
  totalChannels: 0,
  collectedChannels: 0,
  totalItems: 0,
  collectedPlaylists: 0,
  discoveryVideos: 0,
  discoveryPlaylists: 0
});
const isSyncing = ref(false);
const isSearching = ref(false);
const searchQuery = ref('');
const searchType = ref<'all' | 'video' | 'playlist' | 'channel'>('all');
const activeTab = ref<'items' | 'discovery_playlists' | 'channels' | 'collected_channels' | 'collected_playlists' | 'search' | 'blacklist'>('items');
const itemSort = ref('newest');
const channelSort = ref('name');
const KEYWORDS_KEY = 'yt_discovery_keywords';
const discoveryKeywords = ref<string[]>([]);
const newKeyword = ref('');

const loadKeywords = () => {
  try {
    const saved = localStorage.getItem(KEYWORDS_KEY);
    if (saved) {
      discoveryKeywords.value = JSON.parse(saved);
    } else {
      discoveryKeywords.value = [
        'vsinger', '歌ってみた', '歌回', '歌枠', '弾き語り',
        '歌い手', 'VTuber 歌', 'Music Video', 'Cover', 'オリジナル曲'
      ];
    }
  } catch (_) {
    discoveryKeywords.value = ['vsinger', 'Cover'];
  }
};

const saveKeywords = () => {
  try {
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify(discoveryKeywords.value));
  } catch (_) { }
};

const addKeyword = () => {
  const kw = newKeyword.value.trim();
  if (kw && !discoveryKeywords.value.includes(kw)) {
    discoveryKeywords.value.push(kw);
    saveKeywords();
    newKeyword.value = '';
  }
};

const removeKeyword = (kw: string) => {
  discoveryKeywords.value = discoveryKeywords.value.filter(k => k !== kw);
  selectedKeywords.value = selectedKeywords.value.filter(k => k !== kw);
  saveKeywords();
  fetchData();
};

const selectedKeywords = ref<string[]>([]);
const blacklist = ref<any[]>([]);
const isBlacklisting = ref(new Set<string>());

const isAuthReady = ref(false);
const isServerReady = ref(false);
const serverError = ref<string | null>(null);

const checkServer = async (retries = 10) => {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      isServerReady.value = true;
      fetchData();
      return;
    }
  } catch (e) {
    console.warn('Server not ready yet, retrying...', e);
  }

  if (retries > 0) {
    setTimeout(() => checkServer(retries - 1), 2000);
  } else {
    serverError.value = 'Server failed to start. Please try refreshing the page.';
  }
};

const handleReload = () => {
  window.location.reload();
};

const fetchData = async (retries = 3) => {
  if (!isServerReady.value) return;
  try {
    const keywordQuery = selectedKeywords.value.length > 0 ? `&keywords=${encodeURIComponent(selectedKeywords.value.join(','))}` : '';
    const urls = [
      `/api/vsingers?sort=${channelSort.value}`,
      `/api/items?type=video&collected=false&sort=${itemSort.value}${keywordQuery}`,
      `/api/vsingers?collected=true&sort=${channelSort.value}`,
      `/api/items?collected=true&type=playlist&sort=${itemSort.value}`,
      '/api/summary',
      `/api/items?type=playlist&collected=false&sort=${itemSort.value}${keywordQuery}`
    ];

    const results = await Promise.allSettled(urls.map(url => fetch(url)));

    // Check if any request failed completely (network error)
    const failedNetwork = results.filter(r => r.status === 'rejected');
    if (failedNetwork.length > 0) {
      throw new Error('Network error: ' + (failedNetwork[0] as PromiseRejectedResult).reason);
    }

    // Check if any request returned non-ok status
    const failedStatus = results.filter(r => r.status === 'fulfilled' && !r.value.ok);
    if (failedStatus.length > 0) {
      throw new Error('API error: ' + (failedStatus[0] as PromiseFulfilledResult<Response>).value.statusText);
    }

    // All good, parse JSON
    const [channelsData, discoveryVideosData, collectedChannelsData, collectedPlaylistsData, statsData, discoveryPlaylistsData] = await Promise.all(
      results.map(r => (r as PromiseFulfilledResult<Response>).value.json())
    );

    stats.value = statsData;

    if (activeTab.value === 'items') {
      items.value = discoveryVideosData;
    } else if (activeTab.value === 'discovery_playlists') {
      items.value = discoveryPlaylistsData;
    } else if (activeTab.value === 'channels') {
      channels.value = channelsData;
    } else if (activeTab.value === 'collected_channels') {
      channels.value = collectedChannelsData;
    } else if (activeTab.value === 'collected_playlists') {
      items.value = collectedPlaylistsData;
    } else if (activeTab.value === 'blacklist') {
      const res = await fetch('/api/blacklist');
      if (res.ok) blacklist.value = await res.json();
    }
  } catch (e) {
    console.error('Fetch error:', e);
    if (retries > 0) {
      console.log(`Retrying... (${retries} attempts left)`);
      setTimeout(() => fetchData(retries - 1), 2000);
    } else {
      // If all retries fail, maybe the server restarted. Let's re-check health.
      isServerReady.value = false;
      checkServer();
    }
  }
};

const handleSearch = async () => {
  if (!searchQuery.value.trim()) return;
  isSearching.value = true;
  activeTab.value = 'search';
  try {
    const typeParam = searchType.value !== 'all' ? `&type=${searchType.value}` : '';
    const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery.value)}${typeParam}`);
    searchResults.value = await res.json();
  } catch (e) {
    console.error(e);
  } finally {
    isSearching.value = false;
  }
};

const isCollecting = ref(new Set<string>());

const toggleCollect = async (item: any, type: 'channel' | 'video' | 'playlist') => {
  if (isCollecting.value.has(item.id)) return;

  const currentStatus = item.is_collected || 0;
  isCollecting.value.add(item.id);

  try {
    // Sanitize itemData to avoid circular references or too much data
    let sanitizedItemData = null;
    if (activeTab.value === 'search') {
      const getItemId = (obj: any) => {
        let id = obj.id || obj.playlist_id || obj.video_id;
        if (typeof id === 'object' && id !== null) id = id.toString();
        return id?.toString();
      };

      const itemId = getItemId(item);

      sanitizedItemData = {
        id: itemId,
        title: getTitle(item),
        type: (item.type || 'video').toLowerCase(),
        thumbnail: getThumbnailUrl(item),
        published: item.published?.toString() || item.publishedAt?.toString(),
        author: item.author ? {
          id: getItemId(item.author) || item.author.id?.toString(),
          name: item.author.name?.toString() || item.author.name,
          handle: item.author.handle,
          thumbnails: item.author.thumbnails
        } : null,
        channel: item.channel ? {
          id: getItemId(item.channel) || item.channel.id?.toString(),
          name: item.channel.name?.toString() || item.channel.name,
          handle: item.channel.handle
        } : null
      };
    }

    const res = await fetch('/api/toggle-favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: item.id,
        type,
        collected: !currentStatus,
        itemData: sanitizedItemData
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to update collection status');
    }

    // Update local state immediately for better UX
    const newStatus = !currentStatus ? 1 : 0;
    if (activeTab.value === 'search') {
      searchResults.value = searchResults.value.map(res => {
        if (res.id === item.id) return { ...res, is_collected: newStatus };
        return res;
      });
    } else if (activeTab.value === 'items' || activeTab.value === 'discovery_playlists' || activeTab.value === 'collected_playlists') {
      // If we are in a discovery tab and just collected, remove it from the list
      if (newStatus === 1 && (activeTab.value === 'items' || activeTab.value === 'discovery_playlists')) {
        items.value = items.value.filter(i => i.id !== item.id);
      } else {
        items.value = items.value.map(i => {
          if (i.id === item.id) return { ...i, is_collected: newStatus };
          return i;
        });
      }
    } else if (activeTab.value === 'channels' || activeTab.value === 'collected_channels') {
      // If we are in a discovery tab and just collected, remove it from the list
      if (newStatus === 1 && activeTab.value === 'channels') {
        channels.value = channels.value.filter(c => c.id !== item.id);
      } else {
        channels.value = channels.value.map(c => {
          if (c.id === item.id) return { ...c, is_collected: newStatus };
          return c;
        });
      }
    }

    // Refresh stats in background
    fetch('/api/summary').then(r => r.json()).then(data => stats.value = data).catch(() => { });

    // If we are in a "collected" tab and just uncollected, we should probably refresh the list
    if (currentStatus === 1 && (activeTab.value === 'collected_channels' || activeTab.value === 'collected_playlists')) {
      await fetchData();
    }
  } catch (e) {
    console.error('Collect error:', e);
    alert(e instanceof Error ? e.message : 'Failed to update collection status');
  } finally {
    isCollecting.value.delete(item.id);
  }
};

const addToBlacklist = async (channel: any) => {
  if (isBlacklisting.value.has(channel.id)) return;
  if (!confirm(`Are you sure you want to blacklist "${channel.name}"? This will remove all their content from your feed.`)) return;

  isBlacklisting.value.add(channel.id);
  try {
    const res = await fetch('/api/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: channel.id,
        name: channel.name,
        handle: channel.handle,
        thumbnail: getThumbnailUrl(channel)
      })
    });
    if (res.ok) {
      // Remove from local lists
      channels.value = channels.value.filter(c => c.id !== channel.id);
      items.value = items.value.filter(i => i.channel_id !== channel.id);
      searchResults.value = searchResults.value.filter(r => {
        const cid = r.type === 'channel' ? r.id : (r.author?.id || r.channel?.id);
        return cid !== channel.id;
      });
      fetch('/api/summary').then(r => r.json()).then(data => stats.value = data);
    }
  } catch (e) {
    console.error(e);
  } finally {
    isBlacklisting.value.delete(channel.id);
  }
};

const removeFromBlacklist = async (id: string) => {
  try {
    const res = await fetch(`/api/blacklist/${id}`, { method: 'DELETE' });
    if (res.ok) {
      blacklist.value = blacklist.value.filter(b => b.id !== id);
    }
  } catch (e) {
    console.error(e);
  }
};

const syncData = async () => {
  isSyncing.value = true;
  try {
    await fetch('/api/sync', { method: 'POST' });
    await fetchData();
  } catch (e) {
    console.error(e);
  } finally {
    isSyncing.value = false;
  }
};

const handleExport = async () => {
  try {
    const response = await fetch('/api/export');
    if (!response.ok) throw new Error('Export failed');
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vsinger_tracker_export_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  } catch (e) {
    console.error('Export failed:', e);
  }
};

const importFileRef = ref<HTMLInputElement | null>(null);
const isImporting = ref(false);
const importMessage = ref<{ type: 'success' | 'error'; text: string } | null>(null);

const handleImportClick = () => {
  importMessage.value = null;
  importFileRef.value?.click();
};

const handleImportFile = async (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  isImporting.value = true;
  importMessage.value = null;
  try {
    const text = await file.text();
    const data = JSON.parse(text) as { channels?: unknown[]; items?: unknown[]; blacklist?: unknown[] };
    const channels = Array.isArray(data.channels) ? data.channels : [];
    const items = Array.isArray(data.items) ? data.items : [];
    const blacklistData = Array.isArray(data.blacklist) ? data.blacklist : [];

    if (channels.length === 0 && items.length === 0 && blacklistData.length === 0) {
      importMessage.value = { type: 'error', text: 'No channels, items, or blacklist in file.' };
      return;
    }
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels, items, blacklist: blacklistData })
    });
    const result = await res.json();
    if (!res.ok) {
      importMessage.value = { type: 'error', text: result.error || 'Import failed.' };
      return;
    }
    const { imported, skipped } = result;
    importMessage.value = {
      type: 'success',
      text: `Imported ${imported.channels} channels, ${imported.items} items, ${imported.blacklist || 0} blacklist. Skipped ${skipped.channels} channels, ${skipped.items} items.`
    };
    await fetchData();
    setTimeout(() => { importMessage.value = null; }, 5000);
  } catch (err) {
    importMessage.value = { type: 'error', text: err instanceof Error ? err.message : 'Invalid file or import failed.' };
  } finally {
    isImporting.value = false;
  }
};

onMounted(() => {
  try {
    isDark.value = localStorage.getItem(DARK_KEY) === '1';
  } catch (_) { }
  document.documentElement.classList.toggle('dark', isDark.value);
  loadKeywords();
  checkServer();
});

const formatDate = (dateStr: any) => {
  if (!dateStr) return '';
  const str = typeof dateStr === 'object' && dateStr.toString ? dateStr.toString() : dateStr;
  if (!str || str === 'undefined') return '';
  const date = new Date(str);
  if (isNaN(date.getTime())) {
    return typeof str === 'string' ? str : '';
  }
  return date.toLocaleDateString();
};

const getTitle = (item: any) => {
  if (!item) return 'Untitled';
  const t = item.title?.text || item.title?.toString() || item.title;
  if (t && typeof t === 'string' && t !== '[object Object]') return t;
  return 'Untitled';
};

const getThumbnailUrl = (item: any) => {
  let url = '';
  if (item.thumbnail) {
    url = typeof item.thumbnail === 'string' ? item.thumbnail : item.thumbnail.url;
  } else if (item.thumbnails && Array.isArray(item.thumbnails) && item.thumbnails.length > 0) {
    url = item.thumbnails[item.thumbnails.length - 1].url;
  } else if (item.author?.thumbnails && Array.isArray(item.author.thumbnails) && item.author.thumbnails.length > 0) {
    url = item.author.thumbnails[item.author.thumbnails.length - 1].url;
  }

  if (!url) return `https://www.gstatic.com/youtube/img/channels/default_avatar.png`;
  // Ensure absolute URL
  return url.startsWith('//') ? `https:${url}` : url;
};

const getYoutubeUrl = (item: any) => {
  if (!item) return '#';
  const type = (item.type || '').toLowerCase();
  const isPlaylist = type === 'playlist';
  let id = item.id || item.playlist_id;

  if (id && typeof id === 'object') {
    id = id.toString();
  }

  if (!id || id === 'undefined' || id === '[object Object]') return '#';

  return isPlaylist
    ? `https://www.youtube.com/playlist?list=${id}`
    : `https://www.youtube.com/watch?v=${id}`;
};

const setTab = (tab: typeof activeTab.value) => {
  activeTab.value = tab;
  if (tab !== 'search') {
    fetchData();
  }
};
</script>

<template>
  <div class="h-screen flex flex-col bg-[#F5F5F0] dark:bg-gray-900 text-[#141414] dark:text-gray-100 font-sans selection:bg-[#5A5A40] dark:selection:bg-amber-600 selection:text-white overflow-hidden">
    <!-- Server Loading State -->
    <div v-if="!isServerReady" class="fixed inset-0 z-[100] bg-[#F5F5F0] dark:bg-gray-900 flex flex-col items-center justify-center p-6 text-center">
      <div v-if="serverError" class="max-w-md">
        <iconify-icon icon="lucide:alert-circle" width="48" class="text-red-500 mb-4"></iconify-icon>
        <h2 class="text-2xl font-serif italic mb-2">{{ serverError }}</h2>
        <p class="text-sm opacity-60 mb-6">The application server is taking longer than expected to start.</p>
        <button @click="handleReload()" class="px-6 py-2.5 bg-[#5A5A40] dark:bg-amber-600 text-white rounded-full hover:bg-[#4A4A30] dark:hover:bg-amber-700 transition-all text-sm font-medium">
          Reload Page
        </button>
      </div>
      <div v-else class="flex flex-col items-center">
        <div class="w-16 h-16 bg-[#5A5A40] dark:bg-amber-600 rounded-full flex items-center justify-center text-white mb-6 animate-bounce">
          <iconify-icon icon="lucide:music" width="32"></iconify-icon>
        </div>
        <h2 class="text-2xl font-serif italic mb-2">Starting Application...</h2>
        <p class="text-sm opacity-60">Initializing database and YouTube services.</p>
        <div class="mt-8 flex gap-1">
          <div class="w-2 h-2 bg-[#5A5A40] dark:bg-amber-600 rounded-full animate-bounce" style="animation-delay: 0s"></div>
          <div class="w-2 h-2 bg-[#5A5A40] dark:bg-amber-600 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
          <div class="w-2 h-2 bg-[#5A5A40] dark:bg-amber-600 rounded-full animate-bounce" style="animation-delay: 0.4s"></div>
        </div>
      </div>
    </div>

    <!-- Header -->
    <header class="border-b border-[#141414]/10 dark:border-gray-700 bg-white/80 dark:bg-gray-900/90 backdrop-blur-md z-50 shrink-0">
      <div class="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between gap-8">
        <div class="flex items-center gap-3 shrink-0">
          <div class="w-10 h-10 bg-[#5A5A40] dark:bg-amber-600 rounded-full flex items-center justify-center text-white">
            <iconify-icon icon="lucide:music" width="20"></iconify-icon>
          </div>
          <h1 class="text-2xl font-serif italic font-medium tracking-tight hidden sm:block">VSinger & Singer Tracker</h1>
        </div>

        <!-- Search Bar -->
        <div class="flex-1 max-w-2xl relative flex items-center gap-2">
          <div class="relative flex-1">
            <input v-model="searchQuery" @keyup.enter="handleSearch" type="text" placeholder="Search YouTube for Singers & VSingers..." class="w-full bg-[#F5F5F0] dark:bg-gray-800 border-none rounded-full py-2.5 pl-12 pr-4 focus:ring-2 focus:ring-[#5A5A40] dark:focus:ring-amber-500 transition-all text-sm dark:placeholder-gray-400" />
            <iconify-icon icon="lucide:search" class="absolute left-4 top-1/2 -translate-y-1/2 text-[#141414]/40 dark:text-gray-400" width="18"></iconify-icon>
          </div>
          <select v-model="searchType" class="bg-[#F5F5F0] dark:bg-gray-800 border-none rounded-full px-4 py-2.5 text-xs focus:ring-2 focus:ring-[#5A5A40] dark:focus:ring-amber-500 outline-none transition-all">
            <option value="all">All</option>
            <option value="video">Videos</option>
            <option value="playlist">Playlists</option>
            <option value="channel">Channels</option>
          </select>
        </div>

        <input ref="importFileRef" type="file" accept=".json,application/json" class="hidden" @change="handleImportFile" />
        <div class="flex items-center gap-2 shrink-0">
          <button @click="toggleDark" :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'" class="p-2.5 rounded-full border border-[#141414]/10 dark:border-gray-600 bg-white dark:bg-gray-800 text-[#141414] dark:text-amber-400 hover:bg-[#F5F5F0] dark:hover:bg-gray-700 transition-all">
            <iconify-icon v-if="isDark" icon="lucide:sun" width="18"></iconify-icon>
            <iconify-icon v-else icon="lucide:moon" width="18"></iconify-icon>
          </button>
          <button @click="handleImportClick" :disabled="isImporting" class="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-gray-800 border border-[#141414]/10 dark:border-gray-600 text-[#141414] dark:text-gray-100 rounded-full hover:bg-[#F5F5F0] dark:hover:bg-gray-700 transition-all text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed">
            <iconify-icon icon="lucide:upload" width="16" :class="{ 'animate-pulse': isImporting }"></iconify-icon>
            <span class="hidden lg:inline">{{ isImporting ? 'Importing...' : 'Import' }}</span>
          </button>
          <button @click="handleExport" class="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-gray-800 border border-[#141414]/10 dark:border-gray-600 text-[#141414] dark:text-gray-100 rounded-full hover:bg-[#F5F5F0] dark:hover:bg-gray-700 transition-all text-sm font-medium">
            <iconify-icon icon="lucide:download" width="16"></iconify-icon>
            <span class="hidden lg:inline">Export</span>
          </button>
          <button @click="syncData" :disabled="isSyncing" class="flex items-center gap-2 px-6 py-2.5 bg-[#5A5A40] dark:bg-amber-600 text-white rounded-full hover:bg-[#4A4A30] dark:hover:bg-amber-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium">
            <iconify-icon icon="lucide:refresh-cw" width="16" :class="{ 'animate-spin': isSyncing }"></iconify-icon>
            <span class="hidden md:inline">{{ isSyncing ? 'Syncing...' : 'Sync Now' }}</span>
          </button>
        </div>
      </div>
    </header>

    <!-- Import result message -->
    <div v-if="importMessage" :class="[
      'px-6 py-2 text-sm font-medium text-center shrink-0',
      importMessage.type === 'success'
        ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200'
        : 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200'
    ]">
      {{ importMessage.text }}
    </div>

    <main class="flex-1 overflow-y-auto px-6 py-12">
      <div class="max-w-7xl mx-auto">
        <!-- Database Stats Summary -->
        <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-12">
          <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
            <div class="text-[10px] uppercase tracking-widest font-bold text-[#141414]/40 dark:text-gray-400 mb-1">Total Channels</div>
            <div class="text-2xl font-serif italic">{{ stats.totalChannels }}</div>
          </div>
          <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
            <div class="text-[10px] uppercase tracking-widest font-bold text-[#5A5A40] dark:text-amber-400 mb-1">Collected Channels</div>
            <div class="text-2xl font-serif italic">{{ stats.collectedChannels }}</div>
          </div>
          <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
            <div class="text-[10px] uppercase tracking-widest font-bold text-[#141414]/40 dark:text-gray-400 mb-1">Discovery Videos</div>
            <div class="text-2xl font-serif italic">{{ stats.discoveryVideos }}</div>
          </div>
          <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
            <div class="text-[10px] uppercase tracking-widest font-bold text-[#141414]/40 dark:text-gray-400 mb-1">Discovery Playlists</div>
            <div class="text-2xl font-serif italic">{{ stats.discoveryPlaylists }}</div>
          </div>
          <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
            <div class="text-[10px] uppercase tracking-widest font-bold text-[#5A5A40] dark:text-amber-400 mb-1">Collected Playlists</div>
            <div class="text-2xl font-serif italic">{{ stats.collectedPlaylists }}</div>
          </div>
          <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
            <div class="text-[10px] uppercase tracking-widest font-bold text-[#141414]/40 dark:text-gray-400 mb-1">Total Items</div>
            <div class="text-2xl font-serif italic">{{ stats.totalItems }}</div>
          </div>
        </div>

        <!-- Navigation Tabs & Sort -->
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
          <nav class="flex flex-wrap gap-2 p-1 bg-white/50 dark:bg-gray-800/50 rounded-2xl border border-[#141414]/5 dark:border-gray-700 w-fit">
            <button v-for="tab in [
              { id: 'items', label: 'Discovery Videos', icon: 'lucide:video', count: stats.discoveryVideos },
              { id: 'discovery_playlists', label: 'Discovery Playlists', icon: 'lucide:list-video', count: stats.discoveryPlaylists },
              { id: 'channels', label: 'All Channels', icon: 'lucide:users', count: stats.totalChannels },
              { id: 'collected_channels', label: 'Collected Channels', icon: 'lucide:heart', count: stats.collectedChannels },
              { id: 'collected_playlists', label: 'Collected Playlists', icon: 'lucide:list-music', count: stats.collectedPlaylists },
              { id: 'blacklist', label: 'Blacklist', icon: 'lucide:ban', count: blacklist.length },
            ]" :key="tab.id" @click="setTab(tab.id as any)" :class="[
              'px-6 py-2.5 rounded-xl transition-all flex items-center gap-2 text-sm font-medium',
              activeTab === tab.id
                ? 'bg-white dark:bg-gray-700 text-[#141414] dark:text-gray-100 shadow-sm border border-[#141414]/10 dark:border-gray-600'
                : 'text-[#141414]/60 dark:text-gray-400 hover:text-[#141414] dark:hover:text-gray-100 hover:bg-white/50 dark:hover:bg-gray-700/50'
            ]">
              <iconify-icon :icon="tab.icon" width="16"></iconify-icon>
              {{ tab.label }}
              <span v-if="tab.count !== undefined" class="ml-1 px-1.5 py-0.5 bg-[#141414]/5 dark:bg-gray-600 rounded-md text-[10px] font-bold">
                {{ tab.count }}
              </span>
            </button>
          </nav>

          <!-- Sort Options -->
          <div v-if="activeTab !== 'search'" class="flex items-center gap-3">
            <span class="text-[10px] uppercase tracking-widest font-bold text-[#141414]/40 dark:text-gray-400">Sort By</span>
            <select v-if="activeTab === 'items' || activeTab === 'discovery_playlists' || activeTab === 'collected_playlists'" v-model="itemSort" @change="fetchData()" class="bg-white dark:bg-gray-800 border border-[#141414]/10 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-[#5A5A40] dark:focus:ring-amber-500 outline-none">
              <option value="newest">Discovered (Newest)</option>
              <option value="oldest">Discovered (Oldest)</option>
              <option value="published_newest">Published (Newest)</option>
              <option value="published_oldest">Published (Oldest)</option>
              <option value="title">Title (A-Z)</option>
              <option value="title_desc">Title (Z-A)</option>
              <option value="channel">Channel (A-Z)</option>
              <option value="channel_desc">Channel (Z-A)</option>
            </select>
            <select v-else v-model="channelSort" @change="fetchData()" class="bg-white dark:bg-gray-800 border border-[#141414]/10 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-[#5A5A40] dark:focus:ring-amber-500 outline-none">
              <option value="name">Name (A-Z)</option>
              <option value="name_desc">Name (Z-A)</option>
              <option value="newest">Discovered (Newest)</option>
              <option value="oldest">Discovered (Oldest)</option>
              <option value="synced_newest">Recently Synced</option>
              <option value="synced_oldest">Oldest Synced</option>
            </select>
          </div>
        </div>

        <!-- Keyword Filters -->
        <div v-if="activeTab === 'items' || activeTab === 'discovery_playlists'" class="mb-8 space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[10px] uppercase tracking-widest font-bold text-[#141414]/40 dark:text-gray-400 mr-2">Filter Keywords</span>
            <div v-for="kw in discoveryKeywords" :key="kw" class="group flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-medium transition-all border" :class="selectedKeywords.includes(kw)
              ? 'bg-[#5A5A40] dark:bg-amber-600 text-white border-transparent shadow-sm'
              : 'bg-white dark:bg-gray-800 text-[#141414]/60 dark:text-gray-400 border-[#141414]/10 dark:border-gray-700 hover:border-[#5A5A40] dark:hover:border-amber-500'">
              <button @click="() => {
                if (selectedKeywords.includes(kw)) {
                  selectedKeywords = selectedKeywords.filter(k => k !== kw);
                } else {
                  selectedKeywords.push(kw);
                }
                fetchData();
              }">
                {{ kw }}
              </button>
              <button @click.stop="removeKeyword(kw)" class="opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity ml-1" title="Remove Keyword">
                <iconify-icon icon="lucide:x" width="12"></iconify-icon>
              </button>
            </div>
            <button v-if="selectedKeywords.length > 0" @click="() => { selectedKeywords = []; fetchData(); }" class="text-[10px] uppercase tracking-widest font-bold text-red-500 hover:text-red-600 ml-2">
              Clear All
            </button>
          </div>

          <!-- Add Keyword UI -->
          <div class="flex items-center gap-2">
            <input v-model="newKeyword" @keyup.enter="addKeyword" type="text" placeholder="Add new filter keyword..." class="bg-white dark:bg-gray-800 border border-[#141414]/10 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:ring-2 focus:ring-[#5A5A40] dark:focus:ring-amber-500 outline-none w-48" />
            <button @click="addKeyword" class="p-1.5 bg-[#5A5A40] dark:bg-amber-600 text-white rounded-lg hover:bg-[#4A4A30] dark:hover:bg-amber-700 transition-all">
              <iconify-icon icon="lucide:plus" width="16"></iconify-icon>
            </button>
          </div>
        </div>

        <!-- Search Results Title -->
        <div v-if="activeTab === 'search'" class="mb-8 flex items-center justify-between">
          <h2 class="text-2xl font-serif italic">Search Results for "{{ searchQuery }}"</h2>
          <button @click="setTab('items')" class="text-sm text-[#5A5A40] dark:text-amber-400 hover:underline">Back to Discovery</button>
        </div>

        <!-- Content Grid -->
        <div v-if="activeTab === 'items' || activeTab === 'discovery_playlists' || activeTab === 'collected_playlists' || activeTab === 'search'" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          <!-- Display Items (Videos/Playlists) -->
          <div v-for="item in (activeTab === 'search' ? searchResults.filter(r => (r.type || '').toLowerCase() !== 'channel') : items)" :key="item.id" class="group bg-white dark:bg-gray-800 rounded-3xl overflow-hidden border border-[#141414]/5 dark:border-gray-700 hover:border-[#141414]/20 dark:hover:border-gray-600 transition-all hover:shadow-2xl hover:shadow-black/5 dark:hover:shadow-black/20">
            <div class="aspect-video relative overflow-hidden">
              <img :src="getThumbnailUrl(item)" class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" referrerpolicy="no-referrer" />
              <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-6 gap-2">
                <a :href="getYoutubeUrl(item)" target="_blank" class="flex-1 py-3 bg-white dark:bg-gray-700 text-black dark:text-white rounded-xl text-center font-medium flex items-center justify-center gap-2">
                  Watch <iconify-icon icon="lucide:external-link" width="14"></iconify-icon>
                </a>
                <button @click.stop="toggleCollect(item, (item.type || 'video').toLowerCase() as any)" class="w-12 h-12 bg-white/20 backdrop-blur-md text-white rounded-xl flex items-center justify-center hover:bg-white/40 transition-colors disabled:opacity-50" :disabled="isCollecting.has(item.id)">
                  <iconify-icon :icon="isCollecting.has(item.id) ? 'lucide:loader-2' : 'lucide:bookmark'" width="20" :class="{ 'animate-spin': isCollecting.has(item.id), 'text-amber-400': item.is_collected }"></iconify-icon>
                </button>
              </div>
              <div class="absolute top-4 right-4 px-3 py-1 bg-black/50 backdrop-blur-md text-white text-[10px] uppercase tracking-widest rounded-full">
                {{ item.type || 'video' }}
              </div>
            </div>
            <div class="p-6">
              <div class="flex items-center gap-2 mb-3">
                <span class="text-[10px] uppercase tracking-widest font-bold text-[#5A5A40] dark:text-amber-400">
                  {{ item.channel?.name || item.channel_name || 'Unknown' }}
                </span>
                <span class="w-1 h-1 bg-[#141414]/20 dark:bg-gray-500 rounded-full"></span>
                <span class="text-[10px] uppercase tracking-widest text-[#141414]/40 dark:text-gray-400">
                  {{ formatDate(item.published_at || item.published || item.publishedAt) }}
                </span>
              </div>
              <h3 class="text-lg font-serif italic leading-tight group-hover:text-[#5A5A40] dark:group-hover:text-amber-400 transition-colors line-clamp-2">
                {{ item.title }}
              </h3>
            </div>
          </div>
        </div>

        <!-- Channels Grid -->
        <div v-if="activeTab === 'channels' || activeTab === 'collected_channels' || activeTab === 'search'" :class="['grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6', activeTab === 'search' ? 'mt-12 border-t border-[#141414]/10 dark:border-gray-700 pt-12' : '']">
          <div v-if="activeTab === 'search'" class="col-span-full mb-4">
            <h3 class="text-xl font-serif italic text-[#141414] dark:text-gray-100">Channels</h3>
          </div>
          <div v-for="channel in (activeTab === 'search' ? searchResults.filter(r => r.type === 'channel') : channels)" :key="channel.id" class="group bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700 flex flex-col items-center text-center hover:shadow-xl transition-all relative">
            <button @click.stop="toggleCollect(channel, 'channel')" class="absolute top-4 right-4 transition-colors disabled:opacity-50" :class="channel.is_collected ? 'text-red-500' : 'text-[#141414]/20 dark:text-gray-500 hover:text-red-500'" :disabled="isCollecting.has(channel.id)">
              <iconify-icon :icon="isCollecting.has(channel.id) ? 'lucide:loader-2' : 'lucide:heart'" width="18" :class="{ 'animate-spin': isCollecting.has(channel.id) }"></iconify-icon>
            </button>
            <button @click.stop="addToBlacklist(channel)" class="absolute top-4 left-4 text-[#141414]/20 dark:text-gray-500 hover:text-red-600 transition-colors" title="Blacklist Channel" :disabled="isBlacklisting.has(channel.id)">
              <iconify-icon :icon="isBlacklisting.has(channel.id) ? 'lucide:loader-2' : 'lucide:ban'" width="18" :class="{ 'animate-spin': isBlacklisting.has(channel.id) }"></iconify-icon>
            </button>
            <img :src="getThumbnailUrl(channel)" class="w-20 h-20 rounded-full mb-4 object-cover border-2 border-[#5A5A40]/20 dark:border-amber-500/30" referrerpolicy="no-referrer" />
            <h3 class="font-serif italic text-sm leading-tight mb-1">{{ channel.name }}</h3>
            <p v-if="channel.handle" class="text-[10px] text-[#141414]/40 dark:text-gray-400 font-mono mb-2">{{ channel.handle }}</p>
            <a :href="`https://www.youtube.com/channel/${channel.id}`" target="_blank" class="text-[10px] uppercase tracking-widest font-bold text-[#5A5A40] dark:text-amber-400 hover:underline">
              View Channel
            </a>
          </div>
        </div>

        <!-- Blacklist Grid -->
        <div v-if="activeTab === 'blacklist'" class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
          <div v-for="b in blacklist" :key="b.id" class="group bg-white dark:bg-gray-800 p-6 rounded-3xl border border-red-100 dark:border-red-900/30 flex flex-col items-center text-center hover:shadow-xl transition-all relative">
            <button @click.stop="removeFromBlacklist(b.id)" class="absolute top-4 right-4 text-red-600 hover:text-red-700 transition-colors" title="Remove from Blacklist">
              <iconify-icon icon="lucide:trash-2" width="18"></iconify-icon>
            </button>
            <img :src="b.thumbnail" class="w-20 h-20 rounded-full mb-4 object-cover border-2 border-red-500/20 grayscale" referrerpolicy="no-referrer" />
            <h3 class="font-serif italic text-sm leading-tight mb-1 text-gray-500">{{ b.name }}</h3>
            <p v-if="b.handle" class="text-[10px] text-[#141414]/40 dark:text-gray-400 font-mono mb-2">{{ b.handle }}</p>
            <div class="text-[9px] uppercase tracking-widest text-red-500 font-bold">Blacklisted</div>
          </div>
        </div>

        <!-- Empty States -->
        <div v-if="!isSearching && ((activeTab === 'items' && items.length === 0) || (activeTab === 'channels' && channels.length === 0) || (activeTab === 'search' && searchResults.length === 0) || (activeTab === 'blacklist' && blacklist.length === 0))" class="flex flex-col items-center justify-center py-20 opacity-40 dark:opacity-60">
          <iconify-icon icon="lucide:music" width="48" class="mb-4"></iconify-icon>
          <p class="font-serif italic text-xl">Nothing found here.</p>
          <p class="text-sm">Try syncing or searching for something else.</p>
        </div>

        <div v-if="isSearching" class="flex flex-col items-center justify-center py-20">
          <iconify-icon icon="lucide:refresh-cw" width="48" class="animate-spin text-[#5A5A40] dark:text-amber-400 mb-4"></iconify-icon>
          <p class="font-serif italic text-xl">Searching YouTube...</p>
        </div>
      </div>
    </main>
  </div>
</template>
