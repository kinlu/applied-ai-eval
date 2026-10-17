/**
 * Words an output line uses that none of its sources ever does.
 *
 * Generation sometimes pads an answer with a plausible claim the inputs never
 * mention ("Coordinated release triage with product stakeholders", "We
 * guarantee a reply within two hours"). Such a line carries at least one
 * content word found nowhere in the sources. Tense, number and derivation are
 * folded ("led" / "leads", "coordination" / "coordinated"), compounds are
 * compared part by part ("event-sourced" / "event sourcing"), and words that
 * frame a fact without adding one ("owns", "collaborated", "team", "thanks")
 * are ignored.
 *
 * English only: words are ASCII letter runs, so CJK text is never flagged.
 * Calibrated on resume output, where about 3.5% of lines were flagged and
 * every known invented duty was caught; recalibrate the framing list (or pass
 * `allow`) for other domains.
 */

/** Grammar words only: domain filler such as "stakeholders" is exactly what this check looks for. */
const FUNCTION_WORDS = new Set([
  'about', 'above', 'across', 'after', 'against', 'along', 'alongside', 'also', 'among', 'amongst', 'and', 'another',
  'any', 'around', 'beside', 'besides', 'despite', 'inside', 'outside', 'unlike', 'versus', 'whilst',
  'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'can', 'could', 'did', 'does',
  'doing', 'down', 'during', 'each', 'either', 'else', 'even', 'ever', 'every', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'her', 'here', 'hers', 'him', 'his', 'how', 'however', 'into',
  'its', 'itself', 'just', 'less', 'many', 'might', 'more', 'most', 'much', 'must', 'neither', 'nor', 'not',
  'off', 'often', 'once', 'only', 'onto', 'other', 'others', 'otherwise', 'our', 'ours', 'ourselves', 'out',
  'over', 'own', 'per', 'quite', 'rather', 'same', 'several', 'shall', 'she', 'should', 'since', 'some',
  'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'therefore',
  'these', 'they', 'this', 'those', 'though', 'through', 'throughout', 'thus', 'till', 'too', 'toward',
  'towards', 'under', 'until', 'upon', 'very', 'via', 'was', 'were', 'what', 'whatever', 'when', 'whenever',
  'where', 'whereas', 'wherever', 'whether', 'which', 'while', 'who', 'whom', 'whose', 'why', 'will', 'with',
  'within', 'without', 'would', 'yet', 'you', 'your', 'yours', 'yourself',
]);

/** Words that frame a fact without adding one: action verbs, scope words, generic nouns, courtesy. */
const FRAMING_WORDS = [
  'deliver', 'own', 'lead', 'run', 'serve', 'hold', 'act', 'sit', 'drive', 'build', 'support', 'maintain',
  'manage', 'oversee', 'direct', 'perform', 'develop', 'coordinate', 'collaborate', 'participate', 'contribute',
  'provide', 'ensure', 'enable', 'achieve', 'help', 'assist', 'work', 'partner', 'engage', 'handle', 'execute',
  'implement', 'establish', 'introduce', 'apply', 'use', 'using', 'utilise', 'utilize', 'leverage', 'focus',
  'specialise', 'specialize', 'experience', 'skilled', 'skill', 'skills', 'proven', 'strong', 'extensive',
  'solid', 'hands', 'background', 'expertise', 'knowledge', 'track', 'record', 'responsible', 'key', 'various',
  'multiple', 'range', 'including', 'ongoing', 'daily', 'regular', 'successfully', 'effectively', 'efficiently',
  'closely', 'current', 'recent', 'professional', 'role', 'position', 'team', 'teams', 'member', 'person', 'staff',
  'year', 'month', 'week', 'day', 'night', 'time', 'well', 'high', 'complex', 'diverse', 'wide', 'broad', 'deep',
  'end', 'senior', 'junior', 'level', 'aim', 'goal', 'quality', 'take', 'make', 'get', 'set', 'put', 'keep',
  'bring', 'give', 'show', 'move', 'operate', 'design', 'create', 'improve', 'enhance', 'increase', 'reduce',
  'cut', 'lift', 'raise', 'grow', 'boost', 'streamline', 'optimise', 'optimize', 'accelerate', 'strengthen',
  'expand', 'scale', 'launch', 'spearhead', 'champion', 'orchestrate', 'facilitate', 'liaise', 'communicate',
  'multi', 'meet', 'environment', 'ability', 'abilities', 'comfortable', 'cycle', 'feature', 'based', 'save',
  'different', 'clear', 'core', 'relate', 'beyond', 'plus', 'gain', 'primarily', 'initiate', 'conduct',
  'demonstrate', 'translate', 'part', 'span', 'task', 'duty', 'activity',
  // Conversational framing: greetings, thanks and offers of help carry no claim.
  'hello', 'dear', 'thanks', 'thank', 'please', 'sorry', 'apologise', 'apologize', 'apology', 'appreciate',
  'glad', 'happy', 'hope', 'regards', 'best', 'kind', 'sincerely', 'welcome', 'question', 'reach', 'know',
  'feel', 'free', 'great', 'assistance', 'understand', 'mention', 'note', 'look', 'want', 'like', 'need',
  'sure', 'certainly', 'absolutely', 'happen', 'next', 'step', 'detail', 'information',
];

const IRREGULAR_FORMS: Readonly<Record<string, string>> = {
  led: 'lead', built: 'build', drove: 'drive', driven: 'drive', ran: 'run', sat: 'sit', held: 'hold',
  grew: 'grow', grown: 'grow', made: 'make', won: 'win', taught: 'teach', wrote: 'write', written: 'write',
  oversaw: 'oversee', overseen: 'oversee', began: 'begin', begun: 'begin', brought: 'bring', chose: 'choose',
  chosen: 'choose', gave: 'give', given: 'give', kept: 'keep', met: 'meet', paid: 'pay', sold: 'sell',
  spent: 'spend', took: 'take', taken: 'take', told: 'tell', went: 'go', gone: 'go', found: 'find',
  thought: 'think', understood: 'understand', became: 'become', rose: 'rise', risen: 'rise', saw: 'see',
  seen: 'see', fell: 'fall', fallen: 'fall', felt: 'feel', bought: 'buy', caught: 'catch', dealt: 'deal',
  fought: 'fight', hung: 'hang', laid: 'lay', lent: 'lend', lost: 'lose', meant: 'mean', sent: 'send',
  shown: 'show', spoke: 'speak', spoken: 'speak', stood: 'stand', struck: 'strike', swept: 'sweep',
  thrown: 'throw', threw: 'throw', woke: 'wake', wore: 'wear', worn: 'wear', undertook: 'undertake',
  undertaken: 'undertake', withdrew: 'withdraw',
};

/** Longest first, so "ations" is tried before "ation" and "s". */
const SUFFIXES = [
  'ists', 'ist', 'isations', 'izations', 'isation', 'ization', 'ational', 'ations', 'ation', 'ators', 'ator',
  'ating', 'ated', 'ates', 'ments', 'ment', 'ities', 'ity', 'ions', 'ion', 'ings', 'ing', 'ives', 'ive',
  'ally', 'ers', 'er', 'ors', 'or', 'ies', 'ied', 'ate', 'al', 'ly', 'es', 'ed', 's', 'y', 'e',
];
const MIN_ROOT_LENGTH = 3;
const MIN_WORD_LENGTH = 4;
/** Roots this long or longer also match a source root sharing their first letters (up to 6). */
const PREFIX_MATCH_MIN = 5;
const PREFIX_MATCH_MAX = 6;

/** Crude shared root for tense, number and derivation variants; only has to agree with itself. */
export function wordRoot(word: string): string {
  let root = IRREGULAR_FORMS[word] ?? word;
  for (let changed = true; changed;) {
    changed = false;
    for (const suffix of SUFFIXES) {
      if (root.endsWith(suffix) && root.length - suffix.length >= MIN_ROOT_LENGTH) {
        root = root.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return root.replace(/([bcdfgklmnprstvz])\1$/, '$1');
}

const FRAMING_ROOTS = new Set(FRAMING_WORDS.map(wordRoot));

/** Content words at least `minLength` long, compounds split into their parts. */
function contentWords(text: string, minLength: number): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/+-]+/g, ' ')
    .split(/\s+/)
    .flatMap((token) => token.split(/[/+-]/))
    .filter((word) => word.length >= minLength && !FUNCTION_WORDS.has(word) && !/\d/.test(word));
}

export interface SupportVocabulary {
  roots: ReadonlySet<string>;
  prefixes: ReadonlySet<string>;
}

/**
 * The roots an output line may use: everything the sources say. Short words
 * count here although lines skip them, so "sees" or "fixes" in a line still
 * finds "see" or "fix" in a source.
 */
export function supportVocabulary(texts: readonly string[]): SupportVocabulary {
  const roots = new Set(texts.flatMap((text) => contentWords(text, MIN_ROOT_LENGTH)).map(wordRoot));
  const prefixes = new Set<string>();
  for (const root of roots) {
    for (let length = PREFIX_MATCH_MIN; length <= Math.min(PREFIX_MATCH_MAX, root.length); length += 1) {
      prefixes.add(root.slice(0, length));
    }
  }
  return { roots, prefixes };
}

function supported(root: string, vocabulary: SupportVocabulary): boolean {
  if (vocabulary.roots.has(root) || FRAMING_ROOTS.has(root)) return true;
  if (root.length < PREFIX_MATCH_MIN) return false;
  return vocabulary.prefixes.has(root.slice(0, PREFIX_MATCH_MAX));
}

/** The line's words (first spelling of each root) that the vocabulary does not support, in order. */
export function unsupportedWords(line: string, vocabulary: SupportVocabulary): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of contentWords(line, MIN_WORD_LENGTH)) {
    const root = wordRoot(word);
    if (seen.has(root)) continue;
    seen.add(root);
    if (!supported(root, vocabulary)) words.push(word);
  }
  return words;
}
