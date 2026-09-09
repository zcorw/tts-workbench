import type { Rule } from './types';
export const samples = [
  {
    title: '京都、朝の散歩',
    text: '朝の京都は、まだ静けさに包まれている。\n鴨川のほとりを歩くと、水面に柔らかな光が揺れていた。橋の向こうから、焼きたてのパンの香りがする。\n\n小さな喫茶店でコーヒーを注文し、窓の外を眺める。何気ない風景の中に、旅の楽しさが隠れている。もう少しだけ、京都の朝を歩いてみよう。\n\n次の旅では、東京の日本橋を訪ねたい。\n古い建物と新しい街並みが出会う日本橋で、また違った朝の景色を見つけられるだろう。',
  },
  {
    title: '旅の記憶',
    text: '日本橋に着いたのは、よく晴れた日曜日だった。\n橋を渡りながら、以前訪れた京都のことを思い出す。\n\n鴨川で聞いた水の音と、日本橋で感じた街のにぎわい。違う場所で過ごした時間が、一冊のノートの中でつながっていく。',
  },
];
export function applyRules(text: string, rules: Rule[]) {
  const ordered = rules
    .filter((r) => r.word)
    .slice()
    .sort((a, b) => b.word.length - a.word.length);
  const matches: { start: number; end: number; rule: Rule }[] = [];
  let output = '',
    cursor = 0;
  while (cursor < text.length) {
    const rule = ordered.find((r) => text.startsWith(r.word, cursor));
    if (rule) {
      matches.push({ start: cursor, end: cursor + rule.word.length, rule });
      output += rule.reading;
      cursor += rule.word.length;
    } else output += text[cursor++];
  }
  return { matches, output };
}
export const escapeHTML = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
