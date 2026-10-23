// Native file hashing avoids reading image bytes or hashing them repeatedly on the JS thread.
function fingerprint(api, filePath) {
  if (typeof api.getFileInfo !== 'function') return Promise.resolve('');
  return new Promise(resolve => {
    let finished = false;
    const done = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => done(''), 2500);
    try {
      api.getFileInfo({ filePath, digestAlgorithm: 'sha1',
        success: r => done(/^[a-f0-9]{40}$/i.test(r.digest || '') && Number.isFinite(r.size) ? `${r.digest.toLowerCase()}:${r.size}` : ''),
        fail: () => done('') });
    } catch (_) { done(''); }
  });
}
async function inspect(api, paths) {
  const fingerprints = await Promise.all(paths.map(path => fingerprint(api, path)));
  return fingerprints.map((hash, index) => ({ hash, duplicateOf: paths.findIndex((path, i) => i < index &&
    (path === paths[index] || hash && hash === fingerprints[i])) }));
}
module.exports = { inspect };
