<script setup lang="ts">
/**
 * Live stream card — thumbnail + info block + all links.
 *
 * Modelled on the `camlisted` reference project's live entries: a large
 * thumbnail, a dense information block, and a channel link. The extra part
 * here is the *all links* row, which lists every platform the performer is
 * present on.
 */
import { computed, ref, watch } from "vue";
import type { Item } from "@shared/lib/types";
import { formatCount, formatDuration, formatRelative, formatUntil } from "@/lib/dataset";
import { imageUrl } from "@/lib/image";
import { channelLinks, itemUrl, platformMeta } from "@/lib/links";
import type { ChannelSummary } from "@shared/lib/types";
import { isScheduleTitle } from "@shared/lib/classify";

const props = defineProps<{
  item: Item;
  channel?: ChannelSummary | null;
  /** Whether the stream is live right now. */
  live?: boolean;
}>();

const emit = defineEmits<{ (e: "open", item: Item): void }>();

const links = computed(() => channelLinks(props.channel));

const thumbnail = computed(() => {
  if (props.item.thumbnail) return imageUrl(props.item.thumbnail);
  if (
    props.item.platform === "youtube" ||
    (!props.item.platform && /^[\w-]{11}$/.test(props.item.id))
  ) {
    return `https://i.ytimg.com/vi/${props.item.id}/hqdefault.jpg`;
  }
  return "";
});
const activeThumbnail = ref("");
watch(
  thumbnail,
  (url) => {
    activeThumbnail.value = url;
  },
  { immediate: true },
);

function onThumbnailError(): void {
  activeThumbnail.value = "";
}

const elapsed = computed(() => {
  const start = props.item.actualStart ?? props.item.scheduledStart;
  if (!start) return null;
  const seconds = Math.max(0, (Date.now() - Date.parse(start)) / 1000);
  if (props.item.status === "upcoming") return formatUntil(start);
  return formatDuration(seconds);
});

const isUpcoming = computed(() => props.item.status === "upcoming");

/** The item announces the week's schedule rather than being a stream. */
const isSchedule = computed(() => isScheduleTitle(props.item.title));

const kindLabel = computed(() =>
  props.item.channelKind === "virtual" ? "VTuber" : "Real",
);
</script>

<template>
  <article class="group relative overflow-hidden rounded-xl border border-black/8 bg-white shadow-sm transition hover:shadow-md dark:border-white/10 dark:bg-neutral-900">
    <!-- Thumbnail -->
    <button type="button" class="relative block aspect-video w-full overflow-hidden bg-neutral-200 dark:bg-neutral-800" :aria-label="`Open ${item.title}`" @click="emit('open', item)">
      <img v-if="activeThumbnail" :src="activeThumbnail" :alt="item.title" referrerpolicy="no-referrer" loading="lazy" decoding="async" class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" @error="onThumbnailError" />
      <span v-else class="grid h-full w-full place-items-center bg-neutral-200 text-2xl dark:bg-neutral-800" aria-hidden="true">
        ♪
      </span>

      <!-- Status pill -->
      <span v-if="live || isUpcoming" class="absolute top-2 left-2 flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-bold tracking-wide text-white uppercase shadow" :class="live ? 'bg-red-600' : 'bg-blue-600'">
        <span v-if="live" class="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
        {{ live ? "Live" : "Upcoming" }}
      </span>

      <!-- Kind badge -->
      <span class="absolute top-2 right-2 rounded-full px-2 py-1 text-[10px] font-semibold text-white shadow backdrop-blur" :class="item.channelKind === 'virtual' ? 'bg-purple-600/85' : 'bg-emerald-600/85'">
        {{ kindLabel }}
      </span>
      <span v-if="item.isAi" class="absolute top-9 right-2 rounded-full bg-fuchsia-600/90 px-2 py-1 text-[10px] font-semibold text-white shadow backdrop-blur" title="AI-generated performer">
        🤖 AI
      </span>

      <!-- Elapsed time -->
      <span v-if="elapsed" class="absolute right-2 bottom-2 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">
        {{ elapsed }}
      </span>

      <!-- Schedule, not a stream -->
      <span v-if="isUpcoming && isSchedule" class="absolute bottom-2 left-2 rounded bg-amber-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow" title="A schedule announcement, not a scheduled stream">
        📅 Schedule
      </span>
    </button>

    <!-- Info block -->
    <div class="space-y-2 p-3">
      <h3 class="line-clamp-2 text-sm leading-snug font-semibold text-neutral-900 dark:text-neutral-100">
        <button type="button" class="text-left hover:underline" @click="emit('open', item)">
          {{ item.title }}
        </button>
      </h3>

      <div class="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
        <img v-if="channel?.avatar" :src="imageUrl(channel.avatar)" :alt="channel.name" referrerpolicy="no-referrer" loading="lazy" class="h-5 w-5 shrink-0 rounded-full" />
        <span class="truncate">{{ item.channelName }}</span>
      </div>

      <!-- Meta row -->
      <dl class="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-black/5 pt-2 text-[11px] text-neutral-500 dark:border-white/8 dark:text-neutral-400">
        <div class="flex justify-between gap-2">
          <dt>Category</dt>
          <dd class="font-medium text-neutral-700 dark:text-neutral-200">
            {{ item.category }}
          </dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>Region</dt>
          <dd class="font-medium text-neutral-700 dark:text-neutral-200">
            {{ item.region.toUpperCase() }}
          </dd>
        </div>
        <div v-if="item.concurrentViewers" class="flex justify-between gap-2">
          <dt>Viewers</dt>
          <dd class="font-medium text-neutral-700 dark:text-neutral-200">
            {{ formatCount(item.concurrentViewers) }}
          </dd>
        </div>
        <div v-else-if="item.viewCount" class="flex justify-between gap-2">
          <dt>Views</dt>
          <dd class="font-medium text-neutral-700 dark:text-neutral-200">
            {{ formatCount(item.viewCount) }}
          </dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>Started</dt>
          <dd class="font-medium text-neutral-700 dark:text-neutral-200">
            {{
              item.status === "upcoming"
                ? formatUntil(item.scheduledStart)
                : formatRelative(item.actualStart ?? item.publishedAt)
            }}
          </dd>
        </div>
        <div v-if="item.duration" class="flex justify-between gap-2">
          <dt>Length</dt>
          <dd class="font-medium text-neutral-700 dark:text-neutral-200">
            {{ formatDuration(item.duration) }}
          </dd>
        </div>
        <div v-if="item.gender !== 'unknown'" class="flex justify-between gap-2">
          <dt>Gender</dt>
          <dd class="font-medium text-neutral-700 dark:text-neutral-200">
            {{ item.gender }}
          </dd>
        </div>
        <div v-if="item.isAcoustic" class="col-span-2 flex justify-between gap-2">
          <dt>Style</dt>
          <dd class="font-medium text-neutral-700 dark:text-neutral-200">
            🎸 Singing while playing an instrument
          </dd>
        </div>
        <div v-if="item.songTitle" class="col-span-2 flex justify-between gap-2">
          <dt>Song</dt>
          <dd class="truncate font-medium text-neutral-700 dark:text-neutral-200">
            {{ item.songTitle }}
            <span v-if="item.originalArtist" class="text-neutral-400">/ {{ item.originalArtist }}</span>
          </dd>
        </div>
      </dl>

      <!-- All links -->
      <div v-if="links.length" class="flex flex-wrap items-center gap-1.5 border-t border-black/5 pt-2 dark:border-white/8">
        <a v-for="link in links" :key="link.url" :href="link.url" target="_blank" rel="noopener noreferrer" :title="`${link.label}${link.handle ? ` · @${link.handle}` : ''}`" class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white transition hover:opacity-85" :style="{ backgroundColor: platformMeta(link.platform).color }">
          <span aria-hidden="true">{{ platformMeta(link.platform).icon }}</span>
          {{ link.label }}
        </a>
        <a :href="itemUrl(item)" target="_blank" rel="noopener noreferrer" class="ml-auto inline-flex items-center gap-1 rounded-md bg-neutral-900 px-2 py-0.5 text-[11px] font-semibold text-white transition hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200">
          Watch
        </a>
      </div>
    </div>
  </article>
</template>
