/**
 * Virtual UP terminology.
 *
 * Curated from the [Moegirl encyclopedia article on Virtual UP terminology
 * and memes](https://zh.moegirl.org.cn/zh-tw/虚拟UP主用语与梗) — the
 * community reference for Chinese-language VTuber vocabulary.
 *
 * ## Why this matters
 *
 * The Chinese VTuber scene has a precise vocabulary that keyword heuristics
 * otherwise miss, and three pieces of it map directly onto fields this
 * project stores:
 *
 * ### 勢 — the "camp" system
 *
 * Every VTuber has a *camp* (勢): the fan community around them. The name of
 * the camp states what kind of performer they are:
 *
 * | Term | Meaning | Maps to |
 * | --- | --- | --- |
 * | **個人勢** | Plans, produces and streams entirely alone | `affiliation: "independent"` |
 * | **企業勢** | Backed by a company — technical support, resource allocation, more exposure at debut | `affiliation: "group"` |
 * | **社團勢** | A circle of fellow VTuber fans rather than a company — between the two | `affiliation: "community"` |
 * | **轉生勢** | Debuted with their real identity and then became a VTuber, or the reverse | recorded on the channel |
 * | **歌勢** | Mainly posts MVs and holds singing streams — *also called a 虛擬歌手 (virtual singer)* | `role: "vsinger"` |
 *
 * A fan writes 「某V的個人勢」 or 「某企業勢」. The presence of 企業勢 in a
 * channel's own description therefore states, positively, that the
 * performer is in a business group — and 個人勢 states that they are not.
 *
 * ### The other terms that matter here
 *
 * - **中之人** — the person behind the avatar: the voice actor and the
 *   motion-capture performer. Its presence confirms a virtual performer.
 * - **切片 / 切片man** — clip channels, and the people who make them. A
 *   channel that curates other creators' clips is not a performer.
 * - **套皮** — using a VTuber avatar without doing VTuber activity. Explicitly
 *   *not* considered a VTuber.
 * - **限定公開 / プレミア公開 / 首播** — a scheduled first broadcast: a
 *   premiere, which is between a live stream and an upload.
 * - **AI烤肉** — a video translated with speech recognition, machine
 *   translation and automatic subtitling. AI-assisted, not a human performance.
 * - **畢業 / 出道** — graduation and debut.
 */

/* -------------------------------------------------------------------------- */
/* 勢 — the camp system                                                       */
/* -------------------------------------------------------------------------- */

/** 個人勢 — the performer plans, produces and streams entirely alone. */
export const SOLO_CAMP = ["個人勢", "个人势", "個人勢力", "solo勢"];

/** 企業勢 — backed by a company or agency. */
export const CORPORATE_CAMP = [
  "企業勢",
  "企业势",
  "事務所勢",
  "事务所势",
  "(((企)))",
  "(((業)))",
  "(((株)))",
];

/** 社團勢 — a circle of fellow VTuber fans, between the two. */
export const COMMUNITY_CAMP = ["社團勢", "社团势", "同好團"];

/** 轉生勢 — debuted as a real identity and then became a VTuber, or the reverse. */
export const REINCARNATION_CAMP = ["轉生勢", "转生势", "転生組", "轉生"];

/** 歌勢 — posts MVs and holds singing streams; also called a virtual singer. */
export const SINGING_CAMP = ["歌勢", "歌势", "歌唱勢", "歌唱势"];

/** 直播勢 / 視頻勢 — the streaming and video camps. */
export const STREAM_CAMP = ["直播勢", "直播势"];
export const VIDEO_CAMP = ["視頻勢", "视频势"];

/* -------------------------------------------------------------------------- */
/* Identity, activity and content                                             */
/* -------------------------------------------------------------------------- */

/** 中之人 — the person behind the avatar. */
export const PERSON_BEHIND = ["中之人", "中之人", "中ノ人"];

/** 切片 / 切片man / 肉片 — clip channels and the people who make them. */
export const CLIP_CHANNELS = [
  "切片man",
  "切片man",
  "切片帳號",
  "切片頻道",
  "肉片",
  "烤片",
  "翻譯頻道",
  "字幕組",
  "搬运",
];

/** 套皮 — a VTuber avatar used without doing VTuber activity. */
export const SKIN_SUIT = ["套皮主播", "套皮"];

/** 限定公開 / プレミア公開 / 首播 — a scheduled first broadcast. */
export const PREMIERE = [
  "限定公開",
  "限定公开",
  "プレミア公開",
  "公开 premiere",
  "首播",
  "首播 premiere",
  "premiere公开",
];

/** AI烤肉 — a video translated with speech recognition and machine translation. */
export const AI_TRANSLATED = ["AI烤肉", "ai烤肉", "AI翻譯", "ai翻译", "自动字幕", "自動字幕"];

/** 畢業 / 出道 — graduation and debut. */
export const GRADUATION = ["畢業", "毕业", "卒業", "引退"];

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/** Every term, grouped, for the docs and the reference page. */
export const GLOSSARY: { term: string; meaning: string }[] = [
  { term: "個人勢", meaning: "Solo performer — plans, produces and streams alone" },
  { term: "企業勢", meaning: "Backed by a company or agency" },
  { term: "社團勢", meaning: "A fan circle rather than a company" },
  { term: "轉生勢", meaning: "Debuted as a real identity, then became a VTuber" },
  { term: "歌勢", meaning: "Posts MVs and singing streams — a virtual singer" },
  { term: "直播勢", meaning: "The streaming camp" },
  { term: "視頻勢", meaning: "The video camp" },
  { term: "中之人", meaning: "The person behind the avatar" },
  { term: "切片", meaning: "Clip channels — curators, not performers" },
  { term: "套皮", meaning: "A VTuber avatar used without VTuber activity" },
  { term: "限定公開", meaning: "A scheduled first broadcast — a premiere" },
  { term: "AI烤肉", meaning: "AI-translated video (speech recognition + MT)" },
  { term: "畢業", meaning: "Graduation — stopping activities" },
  { term: "出道", meaning: "Debut" },
  { term: "工商", meaning: "Commercial work — sponsorships and collaborations" },
  { term: "收益化", meaning: "Monetisation; joining the YouTube Partner Program" },
  { term: "炎上", meaning: "Controversy" },
];
