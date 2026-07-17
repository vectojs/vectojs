// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Entity } from '@vectojs/core';
import { Card } from '../src/Card';

class Leaf extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

describe('Card.onClick (Pressable-style interactivity, findings.md, 2026-07-10)', () => {
  it('wires onClick through the same click-listener pattern as Button', () => {
    let clicked = 0;
    const card = new Card({
      width: 100,
      height: 60,
      label: 'Feature card',
      onClick: () => clicked++,
    });
    card.emit('click', {});
    expect(clicked).toBe(1);
  });

  it('is interactive when given a label + onClick', () => {
    const card = new Card({ width: 100, height: 60, label: 'Feature card', onClick: () => {} });
    expect(card.interactive).toBe(true);
    expect(card.getA11yAttributes()).toEqual({ role: 'group', label: 'Feature card' });
  });

  it('throws when onClick is given without a label (no empty-label interactive region)', () => {
    expect(() => new Card({ width: 100, height: 60, onClick: () => {} })).toThrow(
      /onClick requires a label/,
    );
  });

  it('a plain labeled Card (no onClick) stays interactive but fires nothing on click', () => {
    const card = new Card({ width: 100, height: 60, label: 'Region' });
    expect(card.interactive).toBe(true);
    // No listener registered — emit() on an event with zero listeners is a no-op, not a throw.
    expect(() => card.emit('click', {})).not.toThrow();
  });

  it('a decorative Card (no label, no onClick) stays non-interactive', () => {
    const card = new Card({ width: 100, height: 60 });
    expect(card.interactive).toBe(false);
    expect(card.getA11yAttributes()).toEqual({});
  });
});

describe('Card.setContent fitContent contract', () => {
  it('defaults to fitting both axes to the card box', () => {
    const card = new Card({ width: 280, height: 160 });
    const content = new Leaf();
    card.setContent(content);
    expect(content.width).toBe(280);
    expect(content.height).toBe(160);
  });

  it('fit=false keeps the old position-only add() behavior', () => {
    const card = new Card({ width: 280, height: 160 });
    const content = new Leaf();
    content.width = 40;
    content.height = 30;
    card.setContent(content, false);
    expect(content.width).toBe(40);
    expect(content.height).toBe(30);
  });

  it('re-applies the fit on every update(), not just at setContent() time', () => {
    const card = new Card({ width: 280, height: 160 });
    const content = new Leaf();
    card.setContent(content);
    expect(content.width).toBe(280);

    card.width = 320;
    card.update(16, 16);
    expect(content.width).toBe(320);
  });

  it('a Card with only manually-positioned add()-ed decorations never runs the fit path', () => {
    // setContent was never called; update() must be a no-op with respect to
    // any child sizing (this._content stays null) — plain add()-managed
    // children keep their author-given size regardless of card resizes.
    const card = new Card({ width: 280, height: 160 });
    const decoration = new Leaf();
    decoration.width = 24;
    decoration.height = 24;
    card.add(decoration);
    card.width = 500;
    card.update(16, 16);
    expect(decoration.width).toBe(24);
    expect(decoration.height).toBe(24);
  });
});
