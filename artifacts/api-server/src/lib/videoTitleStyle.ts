const TITLE_HORIZONTAL_MARGIN = 48;
const TITLE_HORIZONTAL_PADDING = 36;

export type VideoTitleFields = {
  dogName: string;
  punchline: string | null;
};

export function buildHookLine(submission: VideoTitleFields): string {
  // Use only the reviewer-saved punchline, never the trick title/description
  // or an unselected AI suggestion. Missing punchlines produce name-only text.
  const punchline = submission.punchline?.trim();
  return [submission.dogName.trim(), punchline].filter(Boolean).join('\n');
}

function estimatedCharacterWidth(character: string, fontSize: number): number {
  if (character === ' ') return fontSize * 0.32;
  if (/[ilI1|.,'`:;!]/.test(character)) return fontSize * 0.3;
  if (/[mwMW@%&]/.test(character)) return fontSize * 0.92;
  if (/[A-Z0-9•]/.test(character)) return fontSize * 0.68;
  return fontSize * 0.58;
}

function estimatedTextWidth(text: string, fontSize: number): number {
  return [...text].reduce(
    (width, character) => width + estimatedCharacterWidth(character, fontSize),
    0,
  );
}

function splitLongTitleWord(word: string, maximumWidth: number, fontSize: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const character of word) {
    if (
      piece.length > 0 &&
      estimatedTextWidth(`${piece}${character}`, fontSize) > maximumWidth
    ) {
      pieces.push(piece);
      piece = character;
    } else {
      piece += character;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** Adds display-only line breaks without changing the title's wording. */
export function wrapHookText(
  hookText: string,
  targetWidth: number,
  fontSize = Math.round(targetWidth / 17),
): string {
  const maximumWidth =
    targetWidth -
    TITLE_HORIZONTAL_MARGIN * 2 -
    TITLE_HORIZONTAL_PADDING * 2;

  return hookText
    .split('\n')
    .flatMap((paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let line = '';

      for (const word of words) {
        const pieces =
          estimatedTextWidth(word, fontSize) <= maximumWidth
            ? [word]
            : splitLongTitleWord(word, maximumWidth, fontSize);
        for (const piece of pieces) {
          const candidate = line ? `${line} ${piece}` : piece;
          if (line && estimatedTextWidth(candidate, fontSize) > maximumWidth) {
            lines.push(line);
            line = piece;
          } else {
            line = candidate;
          }
        }
      }
      if (line || words.length === 0) lines.push(line);
      return lines;
    })
    .join('\n');
}

export type VideoTitleFilterOptions = {
  hookTextPath: string;
  targetWidth: number;
  targetHeight: number;
};

/** Keep processed footage free of burned-in titles; captions belong on the page. */
export function buildVideoTitleFilter({
  hookTextPath,
  targetWidth,
  targetHeight,
}: VideoTitleFilterOptions): string {
  // Retain the filter interface for the production and safe-refresh pipelines.
  void hookTextPath;
  void targetWidth;
  void targetHeight;
  return 'null';
}