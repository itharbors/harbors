import fs from 'node:fs';

export const CSV_FIXTURE_BYTES = Buffer.from(
  '\uFEFFid,,name,name,note\r\n'
  + '0007,x,Alice,A-duplicate,"hello,world"\r\n'
  + '0010,,Bob,B-duplicate,"line one\r\nline two"\r\n'
  + '0002,y,Alice,C-duplicate,\r\n',
  'utf8',
);

export function createCsvFixture(csvPath: string): void {
  fs.writeFileSync(csvPath, CSV_FIXTURE_BYTES, { flag: 'wx' });
}
