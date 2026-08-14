import { Parser, type Quad_Object, type Quad_Subject } from 'n3';
import type { KgEntity, KgFact, KgGraphData, LabelMap, NodeId } from './types';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SKOS_PREF_LABEL = 'http://www.w3.org/2004/02/skos/core#prefLabel';
const SCHEMA_NAME = 'http://schema.org/name';

const LABEL_PREDICATES = new Set([RDFS_LABEL, SKOS_PREF_LABEL, SCHEMA_NAME]);

export interface ParseRdfOptions {
  /** Preferred short-name extractor for type IRIs. Default: local name after `#` or `/`. */
  shortName?: (iri: string) => string;
}

/**
 * Parse a Turtle / N-Triples / N-Quads string into {@link KgGraphData} via N3.
 *
 * - Subjects become entities; `rdf:type` sets `type` (last type wins if many).
 * - `rdfs:label` / `skos:prefLabel` / `schema:name` fill `labels` (language tag → text).
 * - Other object-IRI triples become {@link KgFact}s; literal-only subjects with
 *   no outgoing object links are still kept as entities.
 *
 * Streaming large files should use a chunked host that calls this per slice or
 * drives `N3.StreamParser` directly; this helper is the sync convenience path
 * for fixtures and modest documents.
 */
export function parseRdfTurtle(text: string, options: ParseRdfOptions = {}): KgGraphData {
  const shortName = options.shortName ?? defaultShortName;
  const parser = new Parser();
  const quads = parser.parse(text);

  const entities = new Map<NodeId, KgEntity>();
  const facts: KgFact[] = [];

  const ensure = (id: NodeId): KgEntity => {
    let e = entities.get(id);
    if (!e) {
      e = { id, type: 'Resource', labels: {} };
      entities.set(id, e);
    }
    return e;
  };

  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode' && q.subject.termType !== 'BlankNode') continue;
    const sid = termId(q.subject);
    const sub = ensure(sid);
    const pred = q.predicate.value;

    if (pred === RDF_TYPE && q.object.termType === 'NamedNode') {
      sub.type = shortName(q.object.value);
      continue;
    }

    if (LABEL_PREDICATES.has(pred) && q.object.termType === 'Literal') {
      const lang = q.object.language || '';
      sub.labels = { ...sub.labels, [lang]: q.object.value };
      continue;
    }

    if (q.object.termType === 'NamedNode' || q.object.termType === 'BlankNode') {
      const tid = termId(q.object);
      ensure(tid);
      facts.push({
        source: sid,
        target: tid,
        predicate: shortName(pred),
      });
    }
  }

  // Guarantee every entity has at least an empty-key label fallback.
  for (const e of entities.values()) {
    if (!e.labels[''] && !Object.keys(e.labels).length) {
      e.labels = { '': String(e.id) } satisfies LabelMap;
    } else if (!e.labels['']) {
      const first = Object.values(e.labels)[0];
      if (first) e.labels = { ...e.labels, '': first };
    }
  }

  return { entities: [...entities.values()], facts };
}

function termId(term: Quad_Subject | Quad_Object): NodeId {
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  return term.value;
}

function defaultShortName(iri: string): string {
  const hash = iri.lastIndexOf('#');
  if (hash >= 0 && hash < iri.length - 1) return iri.slice(hash + 1);
  const slash = iri.lastIndexOf('/');
  if (slash >= 0 && slash < iri.length - 1) return iri.slice(slash + 1);
  return iri;
}
