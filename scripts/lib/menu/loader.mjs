// Loader screen: what word shows next to the spinner while a turn runs.
// classic ("Working…") / fable (whimsy) / kurisu (Steins;Gate). Stored in
// settings.loaderStyle; the channel reads it fresh each turn, so a tap applies
// to the next message with no restart. Same pattern as lang.mjs.
import { writeSettings } from "#lib/settings.mjs";
import { LOADER_STYLES, loaderStyle, pickWorkingWord } from "#lib/loader-words.mjs";

const LABELS = {
  classic: "🙂 Classico",
  fable: "✨ Fable",
  kurisu: "🧪 Kurisu",
};

export default {
  parent: "r",
  render(_st, ctx) {
    const cur = loaderStyle();
    const rows = LOADER_STYLES.map((s) => [
      ctx.btn(`${LABELS[s] ?? s}${cur === s ? " ✓" : ""}`, `iva_menu:ld:set:${s}`),
    ]);
    rows.push(ctx.backRow("r"));
    // Show a live sample of the current style so the choice is concrete.
    const sample = pickWorkingWord();
    return {
      text: ctx.tr(
        `⏳ Loader word\n\nWhat shows while I work. Now: ${sample}`,
        `⏳ Слово загрузки\n\nЧто видно, пока я работаю. Сейчас: ${sample}`,
      ),
      rows,
    };
  },
  async on(verb, args, st, ctx) {
    if (verb !== "set") return;
    const style = LOADER_STYLES.includes(args[0]) ? args[0] : "classic";
    writeSettings({ loaderStyle: style });
    st.page = 0;
    await ctx.show(st, "ld"); // stay here so the ✓ and sample update
  },
};
