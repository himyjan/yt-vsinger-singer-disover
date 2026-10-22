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
import { toLanguageList } from "@shared/lib/regions";
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

/**
 * How the region was decided.
 *
 * The region comes from sources of very different quality, so the drawer
 * shows which one was used — a roster entry is authoritative, a script
 * detection is a guess.
 */
/** Role names, in the vocabulary the community uses. */
const ROLE_LABELS: Record<string, string> = {
  vtuber: "VTuber",
  vsinger: "VSinger",
  singer: "Singer",
  musician: "Musician",
  producer: "Producer",
  composer: "Composer",
  unknown: "Unknown",
};

/** Region names, so the UI never shows a bare code. */
const REGION_LABELS: Record<string, string> = {
  jp: "Japan",
  cn: "China",
  tw: "Taiwan",
  hk: "Hong Kong",
  kr: "Korea",
  en: "English-speaking",
  id: "Indonesia",
  my: "Malaysia",
  sea: "Southeast Asia",
  unknown: "Unknown",
};

/** Language names, so the UI never shows a bare code. */
const LANGUAGE_LABELS: Record<string, string> = {
  ja: "Japanese",
  en: "English",
  ko: "Korean",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  id: "Indonesian",
  ms: "Malay",
};

const REGION_SOURCE_LABELS: Record<string, string> = {
  override: "from a manual override",
  roster: "from the Taiwan VTuber roster",
  declared: "from the language the roster lists",
  platform: "from the platform they are on",
  country: "from the channel's published country",
  agency: "from their agency",
  name: "from a Japanese name",
  script: "from the characters in the name",
  unknown: "unknown",
};

/**
 * The number of published videos.
 *
 * The channel record carries the count when the YouTube API supplied it, but
 * most of the catalogue comes from the rosters, which do not publish one —
 * so the platform's own count is used when the channel has one.
 */
const videoCount = computed(() => {
  const own = (props.channel as Channel | null)?.videoCount;
  if (own) return own;
  for (const entry of followers.value) {
    if (entry.n !== null) return entry.n;
  }
  return null;
});

/**
 * The follower count of each platform.
 *
 * A performer on several platforms has several counts, and they are not the
 * same number — so they are shown side by side rather than collapsed into
 * one.
 */
const followers = computed(() => {
  const source = props.channel as unknown as {
    followers?: { p: string; n: number | null; hidden: boolean; v?: number | null }[];
  };
  const list = source.followers ?? [];
  // Every platform is listed, even one that hides its count — "Bilibili:
  // hidden" is information too, and a performer on four platforms should
  // show all four.
  return list.sort((a, b) => (b.n ?? -1) - (a.n ?? -1));
});

/** The languages, whether the field holds one code or a list. */
const languageList = computed(() => toLanguageList(props.channel?.languages));

/** The other names the performer is known by. */
const aliasList = computed(() => {
  const source = props.channel as unknown as { aliases?: string[] } | null;
  return (source?.aliases ?? []).filter(Boolean).slice(0, 4);
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
                <!--
                  The other names the performer is known by.

                  A performer renames, and the name they used to have is the
                  one a fan remembers — so it is kept, and shown here.
                -->
                <p
                  v-if="aliasList.length"
                  class="mt-0.5 truncate text-xs text-neutral-500"
                  :title="aliasList.join(' · ')"
                >
                  aka {{ aliasList.join(" · ") }}
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
                    :title="`Business group: ${channel.agency}`"
                  >
                    🏢 {{ channel.agency }}
                  </span>
                  <span
                    v-else-if="channel.affiliation === 'independent'"
                    class="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-400"
                    title="Independent performer — no agency"
                  >
                    🎪 Independent
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
                    {{ formatCount(videoCount) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-[10px] tracking-wide text-neutral-500 uppercase">
                    Role
                  </dt>
                  <dd class="text-sm font-bold">
                    {{ ROLE_LABELS[channel.role] ?? channel.role }}
                  </dd>
                </div>
              </dl>

              <!-- Region and language, labelled so they are not confused -->
              <dl
                v-if="channel.regionSource || channel.languages?.length"
                class="space-y-1 border-t border-black/5 pt-2 text-[11px] dark:border-white/8"
              >
                <div class="flex justify-between gap-3">
                  <dt class="text-neutral-500">Region</dt>
                  <dd class="text-right font-semibold text-neutral-700 dark:text-neutral-200">
                    {{ REGION_LABELS[channel.region] ?? channel.region }}
                    <span class="font-normal text-neutral-400">
                      ({{ channel.region }})
                    </span>
                  </dd>
                </div>
                <div
                  v-if="languageList.length"
                  class="flex justify-between gap-3"
                >
                  <dt class="text-neutral-500">Language</dt>
                  <dd class="text-right font-semibold text-neutral-700 dark:text-neutral-200">
                    <span
                      v-for="(language, index) in languageList"
                      :key="language"
                      class="whitespace-nowrap"
                    >
                      {{ LANGUAGE_LABELS[language] ?? language }}
                      <span class="font-normal text-neutral-400">
                        ({{ language }})
                      </span>
                      <span v-if="index < languageList.length - 1">, </span>
                    </span>
                  </dd>
                </div>
                <div v-if="channel.regionSource" class="flex justify-between gap-3">
                  <dt class="text-neutral-500">Region from</dt>
                  <dd class="text-right text-neutral-500">
                    {{ REGION_SOURCE_LABELS[channel.regionSource] ?? channel.regionSource }}
                  </dd>
                </div>
                <div v-if="channel.verification" class="flex justify-between gap-3">
                  <dt class="text-neutral-500">Verified</dt>
                  <dd class="text-right text-neutral-500">
                    {{ channel.verification.source }}
                    <span class="opacity-70">
                      ({{ channel.verification.checked.join(", ") || "confirmed" }})
                    </span>
                  </dd>
                </div>
                <div v-else class="flex justify-between gap-3">
                  <dt class="text-neutral-500">Verified</dt>
                  <dd class="text-right text-amber-600 dark:text-amber-400">
                    not verified yet
                  </dd>
                </div>
              </dl>

              <!-- Business and lifecycle -->
              <section v-if="channel.affiliation !== 'unknown' || channel.debutDate || channel.graduateDate">
                <h3 class="mb-2 text-xs font-bold tracking-wide text-neutral-500 uppercase">
                  About the performer
                </h3>
                <dl class="space-y-1.5 text-xs">
                  <div v-if="channel.affiliation !== 'unknown'" class="flex justify-between gap-3">
                    <dt class="text-neutral-500">Affiliation</dt>
                    <dd class="text-right font-semibold text-neutral-800 dark:text-neutral-200">
                      {{
                        channel.affiliation === "independent"
                          ? "Independent (個人勢)"
                          : channel.affiliation === "group"
                            ? channel.agency || "Business group (企業勢)"
                            : channel.affiliation === "community"
                              ? "Community (社團勢)"
                              : "Unknown"
                      }}
                    </dd>
                  </div>
                  <div v-if="channel.debutDate" class="flex justify-between gap-3">
                    <dt class="text-neutral-500">Debut</dt>
                    <dd class="font-semibold text-neutral-800 dark:text-neutral-200">
                      {{ channel.debutDate }}
                    </dd>
                  </div>
                  <div v-if="channel.graduateDate" class="flex justify-between gap-3">
                    <dt class="text-neutral-500">Graduated</dt>
                    <dd class="font-semibold text-neutral-800 dark:text-neutral-200">
                      {{ channel.graduateDate }}
                    </dd>
                  </div>
                </dl>
              </section>

              <!-- Followers, per platform -->
              <section v-if="followers.length">
                <h3 class="mb-2 text-xs font-bold tracking-wide text-neutral-500 uppercase">
                  Followers
                </h3>
                <ul class="space-y-1">
                  <li
                    v-for="entry in followers"
                    :key="entry.p"
                    class="flex items-center justify-between gap-3 rounded-lg border border-black/6 bg-white px-2.5 py-1.5 text-xs dark:border-white/8 dark:bg-neutral-900"
                  >
                    <span class="flex items-center gap-1.5 font-medium">
                      <span aria-hidden="true">
                        {{ platformMeta(entry.p).icon }}
                      </span>
                      {{ platformMeta(entry.p).label }}
                    </span>
                    <span class="text-right font-semibold text-neutral-700 dark:text-neutral-200">
                      {{
                        entry.n === null
                          ? entry.hidden
                            ? "Hidden"
                            : "—"
                          : formatCount(entry.n)
                      }}
                      <span
                        v-if="entry.v"
                        class="ml-1.5 font-normal text-neutral-400"
                      >
                        {{ formatCount(entry.v) }} videos
                      </span>
                    </span>
                  </li>
                </ul>
              </section>

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
