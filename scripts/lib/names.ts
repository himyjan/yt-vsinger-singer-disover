/**
 * The names inside one channel title.
 *
 * A title like 「空星きらめ/Sorahoshi Kirame【にじさんじ】」 carries three
 * things: the Japanese name, the romanised name and the agency. The slash
 * and the brackets separate them. Each part is a name the performer is
 * known by, so each becomes an alias — a search for any of them finds the
 * channel.
 *
 * Kept in its own module because more than one producer needs it: the
 * details pass when it renames a record, and the subscription import when it
 * creates one.
 */
export function splitName(title: string): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > 1 && !out.includes(trimmed)) out.push(trimmed);
  };

  for (const part of title.split(/[\/|｜]/)) {
    const bare = part
      .replace(/[【\[（(].*?[】\]）)]/g, "")
      .replace(/[【\[（(].*$/g, "")
      .trim();
    add(bare);

    /**
     * 「Name Ch. 中之人」 — the YouTube channel-title convention.
     *
     * The part after `Ch.` is the performer's own name, and it is the part
     * someone searches for; the part before is the channel they publish on.
     */
    const suffix = /\sCh\.?\s+(.+)$/i.exec(bare);
    if (suffix) add(suffix[1]!);
  }

  return out;
}
