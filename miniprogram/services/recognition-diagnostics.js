// Opt-in local evaluation only. Never log or persist complete OCR lines.
const parser = require('./pickup-parser');
const layout = require('./recognition-layout');
const names = { code:'pickup_code', station:'station_name', pickupAddress:'pickup_address', carrier:'carrier', waybillNumber:'tracking_number', parcelStatus:'logistics_status', noticeAt:'event_time' };
function analyze(lines, sourceIndex = 0, boxes = [], expected = []) {
  const text = lines.map(parser.clean), extracted = parser.extractCodes(text, boxes);
  const trace = {};
  const result = parser.analyze(lines, sourceIndex, boxes, trace);
  const regions = [], entities = [], relations = [];
  result.records.forEach((record, index) => {
    const source = record.sourceRegions || [];
    const codeLine = extracted.codes.find(c => c.code === record.code);
    const section = codeLine && layout.sectionBounds(text, boxes, codeLine.i);
    regions.push({ id:index, type:section ? section.type : 'notification_or_card', sources:source });
    for (const [field,type] of Object.entries(names)) {
      if (!record[field] || record[field] === parser.UNKNOWN || record[field] === 'unknown') continue;
      const exact = text.map((s,i) => s.includes(String(record[field])) ? i : -1).filter(i => i >= 0 && source.some(r => i >= r.start && i <= r.end));
      const id = entities.length;
      entities.push({ id, type, value:record[field], region:index, lineIndices:exact, evidence:exact.length ? 'literal_in_region' : 'region_inference', sources:source });
      relations.push({ parcel:index, entity:id, rule:exact.length ? 'same_region_literal' : 'bounded_parser_relation' });
    }
  });
  const failures = expected.map(([code, station]) => {
    const raw = text.join('').replace(/\s/g,'').includes(code), candidate = extracted.codes.some(c => c.code === code), final = result.records.find(r => r.code === code);
    return { code, stage:!raw ? 'ocr_missing' : !final ? candidate ? 'candidate_filtered' : 'candidate_extraction' : station && final.station !== station ? trace.placeCandidates.some(p => p.name === station) ? 'field_pairing' : 'location_extraction' : 'parsed', candidateExtracted:candidate || !!final };
  });
  const retryRegions = result.issues.map(issue => ({ reason:'pickup_notice_without_code', sources:issue.sourceRegions }));
  return { ...result, diagnostics:{ lineCount:lines.length, trace, regions, entities, relations, failures, retryRegions } };
}
module.exports = { analyze };
