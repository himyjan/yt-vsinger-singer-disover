<script setup lang="ts">
/**
 * A channel card — avatar, name, follower count and the badges.
 *
 * The same card appears in the Channels tab and in Saved, so it lives in one
 * place: a badge added to a channel must not depend on which tab it is drawn
 * in. The whole card is a button, because the drawer is the only thing it
 * opens.
 */
import type { ChannelSummary } from "@shared/lib/types";
import { formatCount } from "@/lib/dataset";
import { imageUrl } from "@/lib/image";
import OfficialArtistBadge from "@/components/OfficialArtistBadge.vue";

defineProps<{ channel: ChannelSummary }>();

const emit = defineEmits<{ (e: "open", channel: ChannelSummary): void }>();
</script>

<template>
  <button type="button" class="group flex flex-col items-center gap-2 rounded-xl border border-black/8 bg-white p-3 text-center shadow-sm transition hover:shadow-md dark:border-white/10 dark:bg-neutral-900" @click="emit('open', channel)">
    <img :src="imageUrl(channel.avatar)" :alt="channel.name" referrerpolicy="no-referrer" loading="lazy" class="h-16 w-16 rounded-full object-cover ring-2 ring-black/5 transition group-hover:ring-purple-400 dark:ring-white/10" />
    <span class="line-clamp-2 text-xs leading-tight font-semibold">
      {{ channel.name
      }}
      <OfficialArtistBadge v-if="channel.isOfficialArtist" size="xs" class="ml-1" />
    </span>
    <span class="text-[11px] text-neutral-500">
      {{ channel.subscribersHidden
        ? "subs hidden"
        : `${formatCount(channel.subscribers)} subs` }}
    </span>
    <span class="flex flex-wrap justify-center gap-1">
      <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" :class="channel.kind === 'virtual' ? 'bg-purple-600' : 'bg-emerald-600'">
        {{ channel.kind === "virtual" ? "Virtual" : "Real" }}
      </span>
      <span class="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
        {{ channel.region.toUpperCase() }}
      </span>
      <span v-if="channel.isSinging" class="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400" title="Publishes covers, MVs, original songs or live singing">
        🎤 Singing
      </span>
      <span v-if="channel.activity === 'graduated'" class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
        Graduated
      </span>
    </span>
  </button>
</template>
