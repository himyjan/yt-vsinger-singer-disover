<script setup lang="ts">
/**
 * Channel detail drawer.
 *
 * Opens from a channel card, a live card or a subscription. Shows the
 * performer's identity, their statistics, **all** of their links across
 * platforms, and their live/upcoming/recent uploads.
 */
import { computed } from "vue";
import type { Channel, ChannelSummary, Item } from "@shared/lib/types";
import { formatCount, formatDuration, formatRelative } from "@/lib/dataset";
import { channelLinks, itemUrl, platformMeta } from "@/lib/links";
import { state, toggleSaved } from "@/lib/store";

const props = defineProps<{
  channel: Channel | null;
  item: Item | null;
  /** Every item in the dataset, used to list the channel's uploads. */
  items: Item[];
  summaries: ChannelSummary[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-item", item: Item): void;
  (e: "open-channel", channel: Channel | ChannelSummary): void;
}>();

const links = computed(() => channelLinks(props.channel));

const summary = computed(
  () => props.summaries.find((s) => s.id === props.channel?.id) ?? null,
);

const subscribers = computed(() => {
  const full = props.channel as Channel | null;
  if (!full) return summary.value?.subscribers ?? null;
  if (full.subscribers?.tag === "has") return full.subscribers.count;
  return summary.value?.subscribers ?? null;
});

const subscribersHidden = computed(() => {
  const full = props.channel as Channel | null;
  if (full?.subscribers) return full.subscribers.tag === "hidden";
  return summary.value?.subscribersHidden ?? false;
});

/** The performer's uploads, live first. */
const uploads = computed(() => {
  if (!props.channel) return [];
  const channelId = props.channel.id;
  const kind = props.channel.kind;
  return props.items
    .filter((i) => i.channelId === channelId && i.channelKind === kind)
    .sort((a, b) => {
      const rank = (i: Item) =>
        i.status === "live" ? 0 : i.status === "upcoming" ? 1 : 2;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    })
    .slice(0, 24);
});

const activityLabel = computed(() => {
  switch (props.channel?.activity) {
    case "active":
      return { text: "Active", cls: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400" };
    case "graduated":
      return { text: "Graduated", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" };
    case "preparing":
      return { text: "Preparing", cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400" };
    default:
      return { text: "Unknown", cls: "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300" };
  }
});

const saved = computed(() =>
  props.channel ? state.saved.some((s) => s.id === props.channel!.id) : false,
);
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
        v-if="channel"
        class="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        @click.self="emit('close')"
      >
        <Transition
          enter-active-class="transition duration-250 ease-out"
          enter-from-class="translate-x-full"
          leave-active-class="transition duration-150 ease-in"
          leave-to-class="translate-x-full"
          appear
        >
          <div
            class="flex h-full w-full max-w-lg flex-col overflow-y-auto bg-[#f6f5f1] dark:bg-neutral-950"
          >
            <!-- Header -->
            <div
              class="sticky top-0 z-10 flex items-start gap-3 border-b border-black/8 bg-[#f6f5f1]/95 p-4 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/95"
            >
              <img
                :src="channel.avatar ?? ''"
                :alt="channel.name"
                class="h-16 w-16 shrink-0 rounded-full object-cover ring-2 ring-black/5 dark:ring-white/10"
              />
              <div class="min-w-0 flex-1">
                <h2 class="truncate text-lg font-bold">{{ channel.name }}</h2>
                <p
                  v-if="channel.handle"
                  class="truncate text-xs text-neutral-500"
                >
                  @{{ channel.handle }}
                </p>
                <div class="mt-1.5 flex flex-wrap items-center gap-1">
                  <span
                    class="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                    :class="
                      channel.kind === 'virtual'
                        ? 'bg-purple-600'
                        : 'bg-emerald-600'
                    "
                  >
                    {{ channel.kind === "virtual" ? "Virtual" : "Real" }}
                  </span>
                  <span
                    class="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
                  >
                    {{ channel.region.toUpperCase() }}
                  </span>
                  <span
                    v-if="channel.agency"
                    class="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
                  >
                    {{ channel.agency }}
                  </span>
                  <span
                    class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                    :class="activityLabel.cls"
                  >
                    {{ activityLabel.text }}
                  </span>
                </div>
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

            <div class="space-y-5 p-4">
              <!-- Stats -->
              <dl
                class="grid grid-cols-3 gap-2 rounded-xl border border-black/8 bg-white p-3 text-center dark:border-white/10 dark:bg-neutral-900"
              >
                <div>
                  <dt class="text-[10px] tracking-wide text-neutral-500 uppercase">
                    Subscribers
                  </dt>
                  <dd class="text-sm font-bold">
                    {{ subscribersHidden ? "Hidden" : formatCount(subscribers) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-[10px] tracking-wide text-neutral-500 uppercase">
                    Videos
                  </dt>
                  <dd class="text-sm font-bold">
                    {{ formatCount((channel as Channel).videoCount) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-[10px] tracking-wide text-neutral-500 uppercase">
                    Role
                  </dt>
                  <dd class="text-sm font-bold capitalize">
                    {{ channel.role }}
                  </dd>
                </div>
              </dl>

              <!-- All links -->
              <section>
                <h3 class="mb-2 text-xs font-bold tracking-wide text-neutral-500 uppercase">
                  Links
                </h3>
                <div class="flex flex-wrap gap-1.5">
                  <a
                    v-for="link in links"
                    :key="link.url"
                    :href="link.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white transition hover:opacity-85"
                    :style="{ backgroundColor: platformMeta(link.platform).color }"
                  >
                    <span aria-hidden="true">{{
                      platformMeta(link.platform).icon
                    }}</span>
                    {{ link.label }}
                    <span
                      v-if="link.handle"
                      class="font-normal opacity-80"
                    >@{{ link.handle }}</span
                    >
                  </a>
                  <span
                    v-if="!links.length"
                    class="text-xs text-neutral-500"
                  >
                    No links recorded yet.
                  </span>
                </div>
              </section>

              <!-- Bio -->
              <section v-if="channel.description">
                <h3 class="mb-1.5 text-xs font-bold tracking-wide text-neutral-500 uppercase">
                  About
                </h3>
                <p
                  class="text-xs leading-relaxed whitespace-pre-line text-neutral-600 dark:text-neutral-300"
                >
                  {{ channel.description }}
                </p>
              </section>

              <!-- Uploads -->
              <section v-if="uploads.length">
                <h3 class="mb-2 text-xs font-bold tracking-wide text-neutral-500 uppercase">
                  Recent uploads
                </h3>
                <ul class="space-y-1.5">
                  <li
                    v-for="upload in uploads"
                    :key="upload.id"
                    class="flex items-center gap-2.5 rounded-lg border border-black/6 bg-white p-2 dark:border-white/8 dark:bg-neutral-900"
                  >
                    <img
                      :src="
                        upload.thumbnail ??
                        `https://i.ytimg.com/vi/${upload.id}/default.jpg`
                      "
                      :alt="upload.title"
                      loading="lazy"
                      class="h-10 w-16 shrink-0 rounded object-cover"
                    />
                    <div class="min-w-0 flex-1">
                      <a
                        :href="itemUrl(upload)"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="line-clamp-1 text-xs font-semibold hover:underline"
                      >
                        {{ upload.title }}
                      </a>
                      <p class="text-[10px] text-neutral-500">
                        {{ upload.category }} ·
                        {{ formatRelative(upload.publishedAt) }}
                        <span v-if="upload.duration">
                          · {{ formatDuration(upload.duration) }}
                        </span>
                      </p>
                    </div>
                    <span
                      v-if="upload.status === 'live'"
                      class="shrink-0 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
                    >
                      LIVE
                    </span>
                    <span
                      v-else-if="upload.status === 'upcoming'"
                      class="shrink-0 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
                    >
                      SOON
                    </span>
                  </li>
                </ul>
              </section>

              <!-- Save -->
              <button
                type="button"
                class="w-full rounded-full bg-neutral-900 py-2.5 text-sm font-bold text-white transition hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                @click="
                  toggleSaved({
                    id: channel.id,
                    kind: 'channel',
                    title: channel.name,
                    thumbnail: channel.avatar,
                  })
                "
              >
                {{ saved ? "Remove from saved" : "Save channel" }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
