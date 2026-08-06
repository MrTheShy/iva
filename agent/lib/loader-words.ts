// The word shown next to the spinner while a turn runs ("Working…").
//
// Instead of a static word, pick one at random from a pool chosen in /menu
// (settings.loaderStyle). Language comes from AGENT_LANGUAGE / settings.language
// — and unlike i18n.ts (which only knows en/ru), this recognizes "it", so an
// Italian user gets Italian whimsy, not a Russian fallback.
//
// Pure and cheap: read on every turn start, no cache, so a /menu change applies
// to the very next message.

// ".ts", not ".js": this module is loaded by the eve bundle (the channel) AND
// by the poller, which runs raw Node and does not rewrite the specifier. Same
// reason i18n.ts imports settings this way.
import { readSettings } from "./settings.ts";

type Lang = "it" | "en" | "ru";

/** Valid style keys, for the menu to render buttons from one source. */
export const LOADER_STYLES = ["classic", "fable", "kurisu"] as const;
export type LoaderStyle = (typeof LOADER_STYLES)[number];

function lang(): Lang {
  // AGENT_LANGUAGE=it wins: settings.language can only hold en/ru (the menu UI
  // languages i18n knows), so it can never say "it" even when the whole
  // conversation is Italian. The working word shows in the chat flow, so it
  // should match the chat, not the menu. For en/ru, settings then env decide.
  const e = process.env.AGENT_LANGUAGE;
  if (e === "it") return "it";
  const s = readSettings().language;
  if (s === "en" || s === "ru") return s;
  if (e === "en" || e === "ru") return e;
  return "en";
}

// Each style: a per-language list. A turn picks one at random. Typed as a total
// Record so a missing style or language is a compile error, not a runtime "??".
const POOLS: Record<LoaderStyle, Record<Lang, string[]>> = {
  // The original: one plain word.
  classic: {
    it: ["Lavoro…"],
    en: ["Working…"],
    ru: ["Работаю…"],
  },
  // Fable-style whimsy: absurd, harmless gerunds.
  fable: {
    it: [
      "Rimuginando…",
      "Almanaccando…",
      "Cincischiando…",
      "Elucubrando…",
      "Arzigogolando…",
      "Lambiccando…",
      "Scervellandomi…",
      "Congetturando…",
      "Trafficando…",
      "Sbrogliando…",
      "Cogitando…",
      "Frullando idee…",
    ],
    en: [
      "Discombobulating…",
      "Percolating…",
      "Ruminating…",
      "Frolicking…",
      "Conjuring…",
      "Noodling…",
      "Marinating…",
      "Tinkering…",
      "Finagling…",
      "Bamboozling…",
      "Cogitating…",
      "Puttering…",
    ],
    ru: [
      "Кумекаю…",
      "Мудрствую…",
      "Химичу…",
      "Кручу шестерёнки…",
      "Соображаю…",
      "Ковыряюсь…",
      "Замышляю…",
      "Раскидываю мозгами…",
    ],
  },
  // Steins;Gate / Kurisu flavored.
  kurisu: {
    it: [
      "Calcolando…",
      "Divergendo…",
      "Deducendo…",
      "Ipotizzando…",
      "Analizzando la worldline…",
      "Sperimentando…",
      "Convergendo…",
      "Consultando @channel…",
      "Verificando la divergenza…",
      "Elaborando l'ipotesi…",
      "Aprendo la Steins Gate…",
      "El Psy Kongroo…",
    ],
    en: [
      "Calculating…",
      "Diverging…",
      "Deducing…",
      "Hypothesizing…",
      "Analyzing the worldline…",
      "Experimenting…",
      "Converging…",
      "Consulting @channel…",
      "Checking divergence…",
      "Refining the hypothesis…",
      "Opening Steins Gate…",
      "El Psy Kongroo…",
    ],
    ru: [
      "Вычисляю…",
      "Расхождение…",
      "Дедуцирую…",
      "Строю гипотезу…",
      "Анализ мировой линии…",
      "Экспериментирую…",
      "Схожусь к линии…",
      "Читаю @channel…",
      "El Psy Kongroo…",
    ],
  },
};

/** True when an arbitrary string is one of the known styles. */
export function isLoaderStyle(value: unknown): value is LoaderStyle {
  return (
    typeof value === "string" &&
    (LOADER_STYLES as readonly string[]).includes(value)
  );
}

/** The current style from settings, defaulting to classic. */
export function loaderStyle(): LoaderStyle {
  const s = readSettings().loaderStyle;
  return isLoaderStyle(s) ? s : "classic";
}

/** A random working word for this turn, honoring the chosen style + language. */
export function pickWorkingWord(): string {
  const words = POOLS[loaderStyle()][lang()];
  return words[Math.floor(Math.random() * words.length)];
}
