<script setup lang="ts">
/**
 * YouTube's 🎵 Official Artist Channel badge.
 *
 * This is the monochrome icon YouTube renders after an artist's name, not an
 * emoji: the path is copied from the channel page's inline SVG. It follows the
 * surrounding text colour, so it works in both themes.
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** `xs` sits in a small card, `sm` in a drawer title. */
    size?: "xs" | "sm" | "md";
  }>(),
  { size: "sm" },
);

const sizeClass = computed(() => {
  if (props.size === "xs") return "h-3.5 w-3.5";
  if (props.size === "md") return "h-5 w-5";
  return "h-4 w-4";
});
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    :class="[
      sizeClass,
      'inline-block shrink-0 fill-current [vertical-align:-0.15em] text-neutral-500 dark:text-neutral-400',
    ]"
    role="img"
    aria-label="Official Artist Channel"
  >
    <title>
      YouTube Official Artist Channel — releases are managed through YouTube
      Music
    </title>
    <path
      d="M9.03 2.242 8.272 3H7.2A4.2 4.2 0 003 7.2v1.072l-.758.758a4.2 4.2 0 000 5.94l.758.758V16.8A4.2 4.2 0 007.2 21h1.072l.758.758a4.2 4.2 0 005.94 0l.758-.758H16.8a4.2 4.2 0 004.2-4.2v-1.072l.758-.758a4.2 4.2 0 000-5.94L21 8.272V7.2A4.2 4.2 0 0016.8 3h-1.072l-.758-.758a4.2 4.2 0 00-5.94 0Zm7.73 6.638a.5.5 0 01.241.427v1.743a.256.256 0 01-.386.219L14.001 9.7v4.55a2.75 2.75 0 11-2-2.646V6.888a.5.5 0 01.759-.428l4 2.42Z"
    />
  </svg>
</template>
