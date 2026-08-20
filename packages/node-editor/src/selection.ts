export interface DragState {
  nodeId: string;
  originX: number;
  originY: number;
  pointerX: number;
  pointerY: number;
}

export class SelectionState {
  private ids = new Set<string>();
  public drag: DragState | null = null;

  public get selectedIds(): readonly string[] {
    return [...this.ids];
  }
  public has(id: string): boolean {
    return this.ids.has(id);
  }
  public clear(): void {
    this.ids.clear();
  }
  public select(id: string, additive = false): void {
    if (!additive) this.clear();
    this.ids.add(id);
  }
  public toggle(id: string): void {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
  }
}
