declare module '@met4citizen/headtts/modules/language-en-us.mjs' {
  export class Language { dictionary: Record<string, string>; addToDictionary(line: string): void; generate(text: string): { phonemes: string[] }; }
}
declare module '@met4citizen/headtts/dictionaries/en-us.txt' { const text: string; export default text; }
