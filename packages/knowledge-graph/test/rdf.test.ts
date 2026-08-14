import { describe, expect, it } from 'vitest';
import { parseRdfTurtle } from '../src/rdf';

const TTL = `
@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

ex:ada a ex:Person ;
  rdfs:label "Ada"@en ;
  rdfs:label "阿达"@zh-cn ;
  ex:knows ex:bob .

ex:bob a ex:Person ;
  rdfs:label "Bob"@en .
`;

describe('parseRdfTurtle', () => {
  it('builds entities, labels, types, and facts from Turtle', () => {
    const g = parseRdfTurtle(TTL);
    expect(g.entities.length).toBe(2);
    const ada = g.entities.find((e) => String(e.id).endsWith('ada'))!;
    expect(ada.type).toBe('Person');
    expect(ada.labels.en).toBe('Ada');
    expect(ada.labels['zh-cn']).toBe('阿达');
    expect(g.facts).toHaveLength(1);
    expect(g.facts[0]!.predicate).toBe('knows');
  });
});
