import yauzl from 'yauzl';

const SPDX_PATH = 'sbom.spdx.json';
const MAX_SPDX_BYTES = 1024 * 1024;

function openArchive(archive) {
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

export async function readEmbeddedSpdx(archive) {
  const zip = await openArchive(archive);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };

    zip.once('error', fail);
    zip.on('entry', (entry) => {
      if (entry.fileName !== SPDX_PATH) {
        zip.readEntry();
        return;
      }
      if (entry.uncompressedSize > MAX_SPDX_BYTES) {
        fail(new Error('Embedded SPDX metadata exceeds 1 MiB'));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        const chunks = [];
        let size = 0;
        stream.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_SPDX_BYTES) {
            stream.destroy(new Error('Embedded SPDX metadata exceeds 1 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        stream.once('error', fail);
        stream.once('end', () => {
          if (settled) return;
          try {
            const spdx = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (spdx === null || typeof spdx !== 'object' || Array.isArray(spdx)) {
              throw new Error('Embedded SPDX metadata must be an object');
            }
            settled = true;
            zip.close();
            resolve(spdx);
          } catch (parseError) {
            fail(parseError);
          }
        });
      });
    });
    zip.once('end', () => fail(new Error('Kit archive is missing sbom.spdx.json')));
    zip.readEntry();
  });
}
