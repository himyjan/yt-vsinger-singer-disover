<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { Music, Users, RefreshCw, ExternalLink, PlayCircle, Search, Heart, Bookmark, LayoutGrid, ListMusic, Download, Upload, Moon, Sun } from 'lucide-vue-next';

const DARK_KEY = 'yt_sing_dark';
const isDark = ref(false);

const toggleDark = () => {
  isDark.value = !isDark.value;
  try {
    localStorage.setItem(DARK_KEY, isDark.value ? '1' : '0');
  } catch (_) {}
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
  collectedPlaylists: 0
});
const isSyncing = ref(false);
const isSearching = ref(false);
const searchQuery = ref('');
const activeTab = ref<'items' | 'channels' | 'collected_channels' | 'collected_playlists' | 'search'>('items');
const itemSort = ref('newest');
const channelSort = ref('name');

const fetchData = async (retries = 3) => {
  try {
    const [channelsRes, itemsRes, collectedChannelsRes, collectedPlaylistsRes, statsRes] = await Promise.all([
      fetch(`/api/vsingers?sort=${channelSort.value}`),
      fetch(`/api/items?sort=${itemSort.value}`),
      fetch(`/api/vsingers?collected=true&sort=${channelSort.value}`),
      fetch(`/api/items?collected=true&type=playlist&sort=${itemSort.value}`),
      fetch('/api/stats')
    ]);
    
    // Check if any response is not ok
    if (!channelsRes.ok || !itemsRes.ok || !collectedChannelsRes.ok || !collectedPlaylistsRes.ok || !statsRes.ok) {
      throw new Error('One or more API requests failed');
    }

    stats.value = await statsRes.json();

    if (activeTab.value === 'items') {
      items.value = await itemsRes.json();
    } else if (activeTab.value === 'channels') {
      channels.value = await channelsRes.json();
    } else if (activeTab.value === 'collected_channels') {
      channels.value = await collectedChannelsRes.json();
    } else if (activeTab.value === 'collected_playlists') {
      items.value = await collectedPlaylistsRes.json();
    }
  } catch (e) {
    console.error('Fetch error:', e);
    if (retries > 0) {
      console.log(`Retrying... (${retries} attempts left)`);
      setTimeout(() => fetchData(retries - 1), 2000);
    }
  }
};

const handleSearch = async () => {
  if (!searchQuery.value.trim()) return;
  isSearching.value = true;
  activeTab.value = 'search';
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery.value)}`);
    searchResults.value = await res.json();
  } catch (e) {
    console.error(e);
  } finally {
    isSearching.value = false;
  }
};

const toggleCollect = async (item: any, type: 'channel' | 'video' | 'playlist') => {
  const currentStatus = item.is_collected || 0;
  try {
    await fetch('/api/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        id: item.id, 
        type, 
        collected: !currentStatus,
        itemData: activeTab.value === 'search' ? item : null 
      })
    });
    // Refresh data and stats
    await fetchData();
    // Also update search results if we are in search tab
    if (activeTab.value === 'search') {
      searchResults.value = searchResults.value.map(res => {
        if (res.id === item.id) return { ...res, is_collected: !currentStatus ? 1 : 0 };
        return res;
      });
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
    const data = JSON.parse(text) as { channels?: unknown[]; items?: unknown[] };
    const channels = Array.isArray(data.channels) ? data.channels : [];
    const items = Array.isArray(data.items) ? data.items : [];
    if (channels.length === 0 && items.length === 0) {
      importMessage.value = { type: 'error', text: 'No channels or items in file.' };
      return;
    }
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels, items })
    });
    const result = await res.json();
    if (!res.ok) {
      importMessage.value = { type: 'error', text: result.error || 'Import failed.' };
      return;
    }
    const { imported, skipped } = result;
    importMessage.value = {
      type: 'success',
      text: `Imported ${imported.channels} channels, ${imported.items} items. Skipped ${skipped.channels} channels, ${skipped.items} items (already exist).`
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
  } catch (_) {}
  document.documentElement.classList.toggle('dark', isDark.value);
  fetchData();
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
  const type = item.type || (item.constructor.name === 'VideoCompact' ? 'video' : 'playlist');
  return type === 'video' 
    ? `https://www.youtube.com/watch?v=${item.id}`
    : `https://www.youtube.com/playlist?list=${item.id}`;
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
    <!-- Header -->
    <header class="border-b border-[#141414]/10 dark:border-gray-700 bg-white/80 dark:bg-gray-900/90 backdrop-blur-md z-50 shrink-0">
      <div class="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between gap-8">
        <div class="flex items-center gap-3 shrink-0">
          <div class="w-10 h-10 bg-[#5A5A40] dark:bg-amber-600 rounded-full flex items-center justify-center text-white">
            <Music :size="20" />
          </div>
          <h1 class="text-2xl font-serif italic font-medium tracking-tight hidden sm:block">VSinger & Singer Tracker</h1>
        </div>

        <!-- Search Bar -->
        <div class="flex-1 max-w-xl relative">
          <input 
            v-model="searchQuery"
            @keyup.enter="handleSearch"
            type="text" 
            placeholder="Search YouTube for Singers & VSingers..."
            class="w-full bg-[#F5F5F0] dark:bg-gray-800 border-none rounded-full py-2.5 pl-12 pr-4 focus:ring-2 focus:ring-[#5A5A40] dark:focus:ring-amber-500 transition-all text-sm dark:placeholder-gray-400"
          />
          <Search class="absolute left-4 top-1/2 -translate-y-1/2 text-[#141414]/40 dark:text-gray-400" :size="18" />
        </div>
        
        <input
          ref="importFileRef"
          type="file"
          accept=".json,application/json"
          class="hidden"
          @change="handleImportFile"
        />
        <div class="flex items-center gap-2 shrink-0">
          <button 
            @click="toggleDark"
            :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
            class="p-2.5 rounded-full border border-[#141414]/10 dark:border-gray-600 bg-white dark:bg-gray-800 text-[#141414] dark:text-amber-400 hover:bg-[#F5F5F0] dark:hover:bg-gray-700 transition-all"
          >
            <Sun v-if="isDark" :size="18" />
            <Moon v-else :size="18" />
          </button>
          <button 
            @click="handleImportClick"
            :disabled="isImporting"
            class="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-gray-800 border border-[#141414]/10 dark:border-gray-600 text-[#141414] dark:text-gray-100 rounded-full hover:bg-[#F5F5F0] dark:hover:bg-gray-700 transition-all text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload :size="16" :class="{ 'animate-pulse': isImporting }" />
            <span class="hidden lg:inline">{{ isImporting ? 'Importing...' : 'Import' }}</span>
          </button>
          <button 
            @click="handleExport"
            class="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-gray-800 border border-[#141414]/10 dark:border-gray-600 text-[#141414] dark:text-gray-100 rounded-full hover:bg-[#F5F5F0] dark:hover:bg-gray-700 transition-all text-sm font-medium"
          >
            <Download :size="16" />
            <span class="hidden lg:inline">Export</span>
          </button>
          <button 
            @click="syncData"
            :disabled="isSyncing"
            class="flex items-center gap-2 px-6 py-2.5 bg-[#5A5A40] dark:bg-amber-600 text-white rounded-full hover:bg-[#4A4A30] dark:hover:bg-amber-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            <RefreshCw :size="16" :class="{ 'animate-spin': isSyncing }" />
            <span class="hidden md:inline">{{ isSyncing ? 'Syncing...' : 'Sync Now' }}</span>
          </button>
        </div>
      </div>
    </header>

    <!-- Import result message -->
    <div 
      v-if="importMessage" 
      :class="[
        'px-6 py-2 text-sm font-medium text-center shrink-0',
        importMessage.type === 'success' 
          ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200' 
          : 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200'
      ]"
    >
      {{ importMessage.text }}
    </div>

    <main class="flex-1 overflow-y-auto px-6 py-12">
      <div class="max-w-7xl mx-auto">
      <!-- Database Stats Summary -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
        <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
          <div class="text-[10px] uppercase tracking-widest font-bold text-[#141414]/40 dark:text-gray-400 mb-1">Total Talent</div>
          <div class="text-2xl font-serif italic">{{ stats.totalChannels }}</div>
        </div>
        <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
          <div class="text-[10px] uppercase tracking-widest font-bold text-[#5A5A40] dark:text-amber-400 mb-1">Collected Talent</div>
          <div class="text-2xl font-serif italic">{{ stats.collectedChannels }}</div>
        </div>
        <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
          <div class="text-[10px] uppercase tracking-widest font-bold text-[#141414]/40 dark:text-gray-400 mb-1">Total Items</div>
          <div class="text-2xl font-serif italic">{{ stats.totalItems }}</div>
        </div>
        <div class="bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700">
          <div class="text-[10px] uppercase tracking-widest font-bold text-[#5A5A40] dark:text-amber-400 mb-1">Collected Playlists</div>
          <div class="text-2xl font-serif italic">{{ stats.collectedPlaylists }}</div>
        </div>
      </div>

      <!-- Navigation Tabs & Sort -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
        <nav class="flex flex-wrap gap-2 p-1 bg-white/50 dark:bg-gray-800/50 rounded-2xl border border-[#141414]/5 dark:border-gray-700 w-fit">
          <button 
            v-for="tab in [
              { id: 'items', label: 'Discovery', icon: LayoutGrid, count: stats.totalItems },
              { id: 'channels', label: 'All Talent', icon: Users, count: stats.totalChannels },
              { id: 'collected_channels', label: 'Collected Talent', icon: Heart, count: stats.collectedChannels },
              { id: 'collected_playlists', label: 'Collected Playlists', icon: ListMusic, count: stats.collectedPlaylists },
            ]"
            :key="tab.id"
            @click="setTab(tab.id as any)"
            :class="[
              'px-6 py-2.5 rounded-xl transition-all flex items-center gap-2 text-sm font-medium',
              activeTab === tab.id 
                ? 'bg-white dark:bg-gray-700 text-[#141414] dark:text-gray-100 shadow-sm border border-[#141414]/10 dark:border-gray-600' 
                : 'text-[#141414]/60 dark:text-gray-400 hover:text-[#141414] dark:hover:text-gray-100 hover:bg-white/50 dark:hover:bg-gray-700/50'
            ]"
          >
            <component :is="tab.icon" :size="16" />
            {{ tab.label }}
            <span v-if="tab.count !== undefined" class="ml-1 px-1.5 py-0.5 bg-[#141414]/5 dark:bg-gray-600 rounded-md text-[10px] font-bold">
              {{ tab.count }}
            </span>
          </button>
        </nav>

        <!-- Sort Options -->
        <div v-if="activeTab !== 'search'" class="flex items-center gap-3">
          <span class="text-[10px] uppercase tracking-widest font-bold text-[#141414]/40 dark:text-gray-400">Sort By</span>
          <select 
            v-if="activeTab === 'items' || activeTab === 'collected_playlists'"
            v-model="itemSort"
            @change="fetchData()"
            class="bg-white dark:bg-gray-800 border border-[#141414]/10 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-[#5A5A40] dark:focus:ring-amber-500 outline-none"
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
            <option value="title">Title (A-Z)</option>
            <option value="channel">Channel Name</option>
          </select>
          <select 
            v-else
            v-model="channelSort"
            @change="fetchData()"
            class="bg-white dark:bg-gray-800 border border-[#141414]/10 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-[#5A5A40] dark:focus:ring-amber-500 outline-none"
          >
            <option value="name">Name (A-Z)</option>
            <option value="newest">Recently Synced</option>
            <option value="oldest">Oldest Synced</option>
          </select>
        </div>
      </div>

      <!-- Search Results Title -->
      <div v-if="activeTab === 'search'" class="mb-8 flex items-center justify-between">
        <h2 class="text-2xl font-serif italic">Search Results for "{{ searchQuery }}"</h2>
        <button @click="setTab('items')" class="text-sm text-[#5A5A40] dark:text-amber-400 hover:underline">Back to Discovery</button>
      </div>

      <!-- Content Grid -->
      <div v-if="activeTab === 'items' || activeTab === 'collected_playlists' || activeTab === 'search'" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        <!-- Display Items (Videos/Playlists) -->
        <div 
          v-for="item in (activeTab === 'search' ? searchResults.filter(r => r.type === 'video' || r.type === 'playlist') : items)" 
          :key="item.id"
          class="group bg-white dark:bg-gray-800 rounded-3xl overflow-hidden border border-[#141414]/5 dark:border-gray-700 hover:border-[#141414]/20 dark:hover:border-gray-600 transition-all hover:shadow-2xl hover:shadow-black/5 dark:hover:shadow-black/20"
        >
          <div class="aspect-video relative overflow-hidden">
            <img 
              :src="getThumbnailUrl(item)" 
              class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
              referrerpolicy="no-referrer"
            />
            <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-6 gap-2">
              <a 
                :href="getYoutubeUrl(item)" 
                target="_blank"
                class="flex-1 py-3 bg-white dark:bg-gray-700 text-black dark:text-white rounded-xl text-center font-medium flex items-center justify-center gap-2"
              >
                Watch <ExternalLink :size="14" />
              </a>
              <button 
                @click.stop="toggleCollect(item, item.type || 'video')"
                class="w-12 h-12 bg-white/20 backdrop-blur-md text-white rounded-xl flex items-center justify-center hover:bg-white/40 transition-colors"
              >
                <Bookmark :size="20" :class="{ 'fill-white': item.is_collected }" />
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
        <div 
          v-for="channel in (activeTab === 'search' ? searchResults.filter(r => r.type === 'channel') : channels)" 
          :key="channel.id"
          class="group bg-white dark:bg-gray-800 p-6 rounded-3xl border border-[#141414]/5 dark:border-gray-700 flex flex-col items-center text-center hover:shadow-xl transition-all relative"
        >
          <button 
            @click.stop="toggleCollect(channel, 'channel')"
            class="absolute top-4 right-4 text-[#141414]/20 dark:text-gray-500 hover:text-[#5A5A40] dark:hover:text-amber-400 transition-colors"
          >
            <Heart :size="18" :class="{ 'fill-[#5A5A40] text-[#5A5A40] dark:fill-amber-400 dark:text-amber-400': channel.is_collected }" />
          </button>
          <img 
            :src="getThumbnailUrl(channel)" 
            class="w-20 h-20 rounded-full mb-4 object-cover border-2 border-[#5A5A40]/20 dark:border-amber-500/30"
            referrerpolicy="no-referrer"
          />
          <h3 class="font-serif italic text-sm leading-tight mb-1">{{ channel.name }}</h3>
          <p v-if="channel.handle" class="text-[10px] text-[#141414]/40 dark:text-gray-400 font-mono mb-2">{{ channel.handle }}</p>
          <a 
            :href="`https://www.youtube.com/channel/${channel.id}`" 
            target="_blank"
            class="text-[10px] uppercase tracking-widest font-bold text-[#5A5A40] dark:text-amber-400 hover:underline"
          >
            View Channel
          </a>
        </div>
      </div>

      <!-- Empty States -->
      <div v-if="!isSearching && ((activeTab === 'items' && items.length === 0) || (activeTab === 'channels' && channels.length === 0) || (activeTab === 'search' && searchResults.length === 0))" class="flex flex-col items-center justify-center py-20 opacity-40 dark:opacity-60">
        <Music :size="48" class="mb-4" />
        <p class="font-serif italic text-xl">Nothing found here.</p>
        <p class="text-sm">Try syncing or searching for something else.</p>
      </div>

      <div v-if="isSearching" class="flex flex-col items-center justify-center py-20">
        <RefreshCw :size="48" class="animate-spin text-[#5A5A40] dark:text-amber-400 mb-4" />
        <p class="font-serif italic text-xl">Searching YouTube...</p>
      </div>
      </div>
    </main>
  </div>
</template>
