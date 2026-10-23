<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { KnownPlatformId, RegionCode } from "@shared/lib/types";
import {
  ANALYTICS_METRICS,
  ANALYTICS_PLATFORM_SUPPORT,
  filterAnalyticsDays,
  loadAnalyticsRange,
  metricValue,
  formatMetric,
  type AnalyticsDay,
  type AnalyticsMetric,
  type AnalyticsObservation,
} from "@/lib/analytics";
import { platformMeta } from "@/lib/links";
import type { Scope } from "@/lib/store";

const props = defineProps<{
  scope: Scope;
  region: RegionCode | "all";
  platform: string;
}>();

const range = ref<30 | 90 | 365>(30);
const metric = ref<AnalyticsMetric>("followers");
const days = ref<AnalyticsDay[]>([]);
const loading = ref(false);
const error = ref("");
const selectedKey = ref("");
let requestId = 0;

async function refresh(): Promise<void> {
  const request = ++requestId;
  loading.value = true;
  error.value = "";
  try {
    days.value = await loadAnalyticsRange(range.value, true);
    if (request !== requestId) return;
    if (!selectedKey.value && ranked.value.length) {
      selectedKey.value = identity(ranked.value[0]!.latest);
    }
  } catch (cause) {
    if (request === requestId) {
      error.value =
        cause instanceof Error ? cause.message : "Could not load analytics.";
      days.value = [];
    }
  } finally {
    if (request === requestId) loading.value = false;
  }
}

onMounted(refresh);
watch(range, refresh);

function identity(observation: AnalyticsObservation): string {
  return `${observation.platform}:${observation.channelId}`;
}

const filteredDays = computed(() => filterAnalyticsDays(days.value, props));

const ranked = computed(() => {
  const entries = new Map<string, AnalyticsObservation[]>();
  for (const day of filteredDays.value) {
    for (const observation of day.observations) {
      if (metricValue(observation, metric.value) === undefined) continue;
      const key = identity(observation);
      const history = entries.get(key) ?? [];
      history.push(observation);
      entries.set(key, history);
    }
  }
  return [...entries.values()]
    .map((history) => {
      history.sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.sampledAt.localeCompare(b.sampledAt),
      );
      const first = history[0]!;
      const latest = history.at(-1)!;
      const initialValue = metricValue(first, metric.value)!;
      const latestValue = metricValue(latest, metric.value)!;
      return {
        latest,
        history,
        value: latestValue,
        change: history.length > 1 ? latestValue - initialValue : null,
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 100);
});

const selected = computed(
  () =>
    ranked.value.find((entry) => identity(entry.latest) === selectedKey.value) ??
    ranked.value[0] ??
    null,
);

const chart = computed(() => {
  const points = selected.value?.history ?? [];
  if (!points.length) return "";
  const values = points.map((point) => metricValue(point, metric.value)!);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  return values
    .map((value, index) => {
      const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
      const y = 92 - ((value - low) / span) * 84;
      return `${x},${y}`;
    })
    .join(" ");
});

const latestDate = computed(() => filteredDays.value.at(-1)?.date ?? null);
const platformAvailability = computed(() => {
  const ids = props.platform === "all"
    ? Object.keys(ANALYTICS_PLATFORM_SUPPORT) as KnownPlatformId[]
    : [props.platform as KnownPlatformId];
  return ids.map((id) => ({
    id,
    label: platformMeta(id).label,
    note: ANALYTICS_PLATFORM_SUPPORT[id]?.[metric.value] ??
      "This platform does not publish this metric through the current adapter.",
  }));
});
const topContent = computed(() => {
  const content = new Map<string, NonNullable<AnalyticsDay["content"]>[number]>();
  for (const day of filteredDays.value) {
    for (const item of day.content ?? []) {
      const key = `${item.platform}:${item.url || `${item.channelId}:${item.title}`}`;
      content.set(key, item);
    }
  }
  return [...content.values()].sort((a, b) => b.views - a.views).slice(0, 20);
});
</script>

<template>
  <section aria-label="Platform analytics" class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-lg font-bold">Platform analytics</h2>
        <p class="mt-1 text-xs text-neutral-500">
          Daily snapshots; some platforms do not expose every metric.
          <span v-if="latestDate"> Latest sample: {{ latestDate }}</span>
        </p>
      </div>
      <button type="button" class="rounded-full border border-black/10 px-3 py-1.5 text-xs font-semibold dark:border-white/12" :disabled="loading" @click="refresh">
        {{ loading ? "Loading…" : "Refresh" }}
      </button>
    </div>

    <div class="flex flex-wrap gap-2">
      <label class="sr-only" for="analytics-range">History range</label>
      <select id="analytics-range" v-model.number="range" class="rounded-lg border border-black/10 bg-white px-3 py-2 text-xs dark:border-white/12 dark:bg-neutral-900">
        <option :value="30">Last 30 days</option>
        <option :value="90">Last 90 days</option>
        <option :value="365">Last year</option>
      </select>
      <label class="sr-only" for="analytics-metric">Metric</label>
      <select id="analytics-metric" v-model="metric" class="min-w-52 rounded-lg border border-black/10 bg-white px-3 py-2 text-xs dark:border-white/12 dark:bg-neutral-900">
        <option v-for="option in ANALYTICS_METRICS" :key="option.id" :value="option.id">
          {{ option.label }}
        </option>
      </select>
    </div>

    <p v-if="error" role="alert" class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
      {{ error }} The archive is populated by the scheduled sync workflow.
    </p>
    <p v-else-if="!loading && !ranked.length" class="rounded-xl border border-black/8 bg-white p-5 text-sm text-neutral-500 dark:border-white/10 dark:bg-neutral-900">
      No archived snapshots match these filters yet. New daily samples will appear as the sync rotates through tracked channels.
    </p>

    <div v-if="ranked.length" class="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
      <div class="rounded-xl border border-black/8 bg-white p-4 dark:border-white/10 dark:bg-neutral-900">
        <h3 class="text-sm font-bold">
          {{ selected?.latest.channelName ?? "Channel trend" }}
          <span class="font-normal text-neutral-500">· {{ selected ? platformMeta(selected.latest.platform).label : "" }}</span>
        </h3>
        <div class="mt-4 h-40">
          <svg v-if="chart" viewBox="0 0 100 100" preserveAspectRatio="none" class="h-full w-full overflow-visible" role="img" :aria-label="`${metric} trend for ${selected?.latest.channelName ?? 'selected channel'}`">
            <polyline :points="chart" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" class="text-purple-600" />
          </svg>
        </div>
        <p v-if="selected?.history.length" class="mt-2 flex justify-between text-[10px] text-neutral-500">
          <span>{{ selected.history[0]?.date }}</span>
          <span>{{ selected.history.length }} samples</span>
          <span>{{ selected.history.at(-1)?.date }}</span>
        </p>
      </div>

      <aside class="rounded-xl border border-black/8 bg-white p-4 dark:border-white/10 dark:bg-neutral-900">
        <h3 class="text-sm font-bold">Metric coverage</h3>
        <ul class="mt-3 space-y-2 text-xs">
          <li v-for="entry in platformAvailability" :key="entry.id" class="flex justify-between gap-3">
            <span class="shrink-0 font-semibold">{{ entry.label }}</span>
            <span class="text-right text-neutral-500">{{ entry.note }}</span>
          </li>
        </ul>
      </aside>
    </div>

    <div v-if="ranked.length" class="overflow-x-auto rounded-xl border border-black/8 bg-white dark:border-white/10 dark:bg-neutral-900">
      <table class="w-full min-w-[42rem] text-left text-xs">
        <thead class="border-b border-black/8 text-neutral-500 dark:border-white/10">
          <tr>
            <th class="px-3 py-2">#</th>
            <th class="px-3 py-2">Channel</th>
            <th class="px-3 py-2">Platform</th>
            <th class="px-3 py-2 text-right">Latest</th>
            <th class="px-3 py-2 text-right">Change in range</th>
            <th class="px-3 py-2">Sampled</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(entry, index) in ranked" :key="identity(entry.latest)" class="cursor-pointer border-b border-black/5 last:border-0 hover:bg-purple-500/5 dark:border-white/5" :class="identity(entry.latest) === selectedKey ? 'bg-purple-500/10' : ''" @click="selectedKey = identity(entry.latest)">
            <td class="px-3 py-2 text-neutral-500">{{ index + 1 }}</td>
            <td class="px-3 py-2 font-semibold">{{ entry.latest.channelName }}</td>
            <td class="px-3 py-2">{{ platformMeta(entry.latest.platform).label }}</td>
            <td class="px-3 py-2 text-right">{{ formatMetric(entry.value, metric) }}</td>
            <td class="px-3 py-2 text-right" :class="entry.change === null ? 'text-neutral-400' : entry.change >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'">
              {{ entry.change === null ? "Need 2+ samples" : `${entry.change >= 0 ? "+" : ""}${formatMetric(entry.change, metric)}` }}
            </td>
            <td class="px-3 py-2 text-neutral-500">{{ entry.latest.date }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="topContent.length" class="rounded-xl border border-black/8 bg-white p-4 dark:border-white/10 dark:bg-neutral-900">
      <h3 class="text-sm font-bold">Top content in the selected period</h3>
      <ol class="mt-3 grid gap-2 md:grid-cols-2">
        <li v-for="item in topContent" :key="`${item.platform}:${item.url || item.title}`" class="flex items-start justify-between gap-3 rounded-lg bg-neutral-50 p-2 text-xs dark:bg-neutral-800">
          <a v-if="item.url" :href="item.url" target="_blank" rel="noopener noreferrer" class="min-w-0 truncate font-semibold hover:underline">{{ item.channelName }} — {{ item.title }}</a>
          <span v-else class="min-w-0 truncate font-semibold">{{ item.channelName }} — {{ item.title }}</span>
          <span class="shrink-0 text-neutral-500">{{ formatMetric(item.views, "views") }}</span>
        </li>
      </ol>
    </div>
  </section>
</template>
