/**
 * The evidence a discovered channel has to show.
 *
 * Two independent facts have to be visible in a channel's own words before it
 * enters the dataset as a virtual singer:
 *
 *   - **virtual-creator identity** — VTuber, VSinger, バーチャルシンガー, 虚拟歌姬
 *   - **singing** — 歌枠, 歌ってみた, KARAOKE, cover, VSinger
 *
 * Either one alone is not enough. `singer` alone admits ordinary human
 * singers; `vtuber` alone admits the gamers and the chatting channels this
 * catalogue is not about.
 *
 * The terms live here rather than in `scripts/sync.ts` because discovery is no
 * longer the only producer that needs them: `npm run data:discover --promote`
 * applies the same gate to the performers a directory suggests.
 */

/** Singing evidence: the words a channel uses for its own singing content. */
export const SINGING_DISCOVERY_TERMS =
  /(?:vsinger|virtual\s+singer|singer|singing|karaoke|cover\s+song|music\s+video|vocaloid|歌枠|歌い手|歌ってみた|歌唱|歌姫|歌手|唱歌|翻唱|歌曲|歌回|歌回接力|接龍歌枠|歌.{0,8}(?:リレー|relay)|(?:リレー|relay).{0,8}歌|弾き語り|カラオケ|노래|가수|커버|노래방|nyanyi|menyanyi)/iu;

/** Virtual-creator identity, in the languages the catalogue covers. */
export const VIRTUAL_SINGER_DISCOVERY_TERMS =
  /(?:vtuber|v[- ]?tuber|virtual\s+(?:you?tuber|singer)|vsinger|バーチャル(?:youtuber|ユーチューバー|シンガー|歌姫|歌手)|ぶいちゅーばー|虚拟(?:主播|歌姬|歌手)|虛擬(?:主播|歌姬|歌手)|버튜버|버추얼\s*유튜버)/iu;

/** Does any of these texts talk about singing? */
export function hasSingingDiscoveryEvidence(
  values: (string | null | undefined)[],
): boolean {
  return values.some((value) => value && SINGING_DISCOVERY_TERMS.test(value));
}

/** Does any of these texts say the channel is a virtual creator? */
export function hasVirtualIdentityEvidence(
  values: (string | null | undefined)[],
): boolean {
  return values.some((value) => value && VIRTUAL_SINGER_DISCOVERY_TERMS.test(value));
}

/**
 * Counts the distinct videos that carry **both** kinds of evidence.
 *
 * The gate is two videos, not one: a single misleading title is not a
 * classification, and the second video is what makes it a channel rather than
 * a coincidence.
 */
export function evidenceVideoCount(
  videos: { id: string; title: string | null; description?: string | null }[],
): number {
  const ids = new Set<string>();
  for (const video of videos) {
    if (
      hasVirtualIdentityEvidence([video.title, video.description]) &&
      hasSingingDiscoveryEvidence([video.title, video.description])
    ) {
      ids.add(video.id);
    }
  }
  return ids.size;
}
