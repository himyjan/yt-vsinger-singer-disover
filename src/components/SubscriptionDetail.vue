<script setup lang="ts">
/**
 * A subscription's YouTube snapshot.
 *
 * This opens only for a channel that is **not** in the local dataset: a
 * tracked channel has a full drawer already. The point is to see the one
 * thing the subscription feed cannot tell us — the 🎵 Official Artist badge —
 * plus the channel's current live/upcoming state and its releases.
 *
 * The request is made on open, never for the whole subscription list.
 */
import { computed } from "vue";
import type { YouTubeChannelItem } from "@shared/lib/types";
import type { Subscription } from "@/lib/store";
import type { YouTubeChannelDetail } from "@/lib/youtube-detail";
import { formatCount } from "@/lib/dataset";
import OfficialArtistBadge from "@/components/OfficialArtistBadge.vue";

const props = defineProps<{
  sub: Subscription;
  detail: YouTubeChannelDetail | null;
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "retry"): void;
}>();

const channelUrl = computed(
  () => `https://www.youtube.com/channel/${props.sub.channelId}`,
);

/** The feed stores `@handle`; the snapshot stores `handle`. Show one `@`. */
const displayHandle = computed(() =>
  (props.detail?.handle ?? props.sub.handle ?? "").replace(/^@/, ""),
);

function itemUrl(item: YouTubeChannelItem): string {
  return item.kind === "playlist"
    ? `https://www.youtube.com/playlist?list=${item.id}`
    : `https://www.youtube.com/watch?v=${item.id}`;
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Subscription details"
        @click.self="emit('close')"
      >
        <Transition
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="translate-y-2 scale-[0.98] opacity-0"
          leave-active-class="transition duration-150 ease-in"
          leave-to-class="translate-y-2 scale-[0.98] opacity-0"
          appear
        >
          <div
            class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-[#f6f5f1] shadow-2xl dark:bg-neutral-950"
          >
            <!-- Header -->
            <div
              class="flex items-start gap-3 border-b border-black/8 p-4 dark:border-white/10"
            >
              <img
                :src="detail?.avatar ?? sub.thumbnail ?? ''"
                :alt="detail?.title ?? sub.title"
                class="h-14 w-14 shrink-0 rounded-full object-cover ring-2 ring-black/5 dark:ring-white/10"
              />
              <div class="min-w-0 flex-1">
                <h2 class="flex min-w-0 items-center gap-1.5 text-lg font-bold">
                  <span class="truncate">{{ detail?.title ?? sub.title }}</span>
                  <OfficialArtistBadge
                    v-if="detail?.officialArtist"
                    class="shrink-0"
                  />
                </h2>
                <p
                  v-if="displayHandle"
                  class="truncate text-xs text-neutral-500"
                >
                  @{{ displayHandle }}
                </p>
                <p class="mt-0.5 text-[11px] text-neutral-500">
                  <span v-if="detail?.subscribers">
                    {{ formatCount(detail.subscribers) }} subscribers ·
                  </span>
                  YouTube channel
                </p>
              </div>
              <button
                type="button"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-black/5 dark:hover:bg-white/10"
                aria-label="Close"
                @click="emit('close')"
              >
                ✕
              </button>
            </div>

            <div class="space-y-4 overflow-y-auto p-4">
              <!-- Loading -->
              <div
                v-if="loading"
                class="flex items-center justify-center gap-2 rounded-xl border border-black/8 bg-white p-6 text-xs text-neutral-500 dark:border-white/10 dark:bg-neutral-900"
              >
                <span
                  class="h-4 w-4 animate-spin rounded-full border-2 border-purple-500 border-t-transparent"
                  aria-hidden="true"
                ></span>
                Reading the channel from YouTube…
              </div>

              <!-- Error -->
              <div
                v-else-if="error"
                class="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-300"
              >
                {{ error }}
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="rounded-full border border-amber-600/30 px-2.5 py-1 font-semibold"
                    @click="emit('retry')"
                  >
                    Try again
                  </button>
                  <a
                    :href="channelUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="rounded-full border border-amber-600/30 px-2.5 py-1 font-semibold"
                  >
                    Open on YouTube ↗
                  </a>
                </div>
              </div>

              <template v-else-if="detail">
                <!-- Live now -->
                <section v-if="detail.live" aria-label="Live now">
                  <h3
                    class="mb-2 text-[11px] font-bold tracking-wide text-red-600 uppercase dark:text-red-400"
                  >
                    🔴 Live now
                  </h3>
                  <a
                    :href="itemUrl(detail.live)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center gap-2.5 rounded-xl border border-red-500/25 bg-red-500/5 p-2 transition hover:bg-red-500/10"
                  >
                    <img
                      v-if="detail.live.thumbnail"
                      :src="detail.live.thumbnail"
                      :alt="detail.live.title"
                      class="h-12 w-20 shrink-0 rounded-lg object-cover"
                    />
                    <span class="line-clamp-2 text-xs font-semibold">
                      {{ detail.live.title }}
                    </span>
                  </a>
                </section>

                <!-- Upcoming -->
                <section v-if="detail.upcoming" aria-label="Upcoming">
                  <h3
                    class="mb-2 text-[11px] font-bold tracking-wide text-amber-700 uppercase dark:text-amber-400"
                  >
                    📅 Upcoming
                  </h3>
                  <a
                    :href="itemUrl(detail.upcoming)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-2 transition hover:bg-amber-500/10"
                  >
                    <img
                      v-if="detail.upcoming.thumbnail"
                      :src="detail.upcoming.thumbnail"
                      :alt="detail.upcoming.title"
                      class="h-12 w-20 shrink-0 rounded-lg object-cover"
                    />
                    <span class="line-clamp-2 text-xs font-semibold">
                      {{ detail.upcoming.title }}
                    </span>
                  </a>
                </section>

                <!-- Releases -->
                <section v-if="detail.releases.length" aria-label="Songs and releases">
                  <h3
                    class="mb-2 flex items-baseline justify-between text-[11px] font-bold tracking-wide text-neutral-500 uppercase"
                  >
                    <span>🎼 Songs &amp; releases</span>
                    <span class="font-normal normal-case">
                      {{ detail.releaseCount }}
                    </span>
                  </h3>
                  <div class="grid grid-cols-2 gap-2">
                    <a
                      v-for="release in detail.releases"
                      :key="release.id"
                      :href="itemUrl(release)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="flex items-center gap-2 rounded-lg border border-black/6 bg-white p-1.5 transition hover:bg-black/[0.03] dark:border-white/8 dark:bg-neutral-900 dark:hover:bg-white/5"
                    >
                      <img
                        v-if="release.thumbnail"
                        :src="release.thumbnail"
                        :alt="release.title"
                        loading="lazy"
                        class="h-9 w-9 shrink-0 rounded object-cover"
                      />
                      <span class="line-clamp-2 text-[11px] leading-tight font-medium">
                        {{ release.title }}
                      </span>
                    </a>
                  </div>
                </section>

                <p
                  v-if="!detail.live && !detail.upcoming && !detail.releases.length"
                  class="rounded-xl border border-black/8 bg-white p-4 text-center text-xs text-neutral-500 dark:border-white/10 dark:bg-neutral-900"
                >
                  No live stream, scheduled stream or release is listed right now.
                </p>
              </template>
            </div>

            <!-- Footer -->
            <div
              class="flex flex-wrap items-center justify-between gap-2 border-t border-black/8 p-3 dark:border-white/10"
            >
              <a
                :href="channelUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs font-semibold text-purple-700 hover:underline dark:text-purple-300"
              >
                Open channel on YouTube ↗
              </a>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="rounded-full border border-black/10 px-3 py-1.5 text-xs font-semibold disabled:opacity-40 dark:border-white/12"
                  :disabled="loading"
                  @click="emit('retry')"
                >
                  Refresh details
                </button>
                <button
                  type="button"
                  class="rounded-full bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
                  @click="emit('close')"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
