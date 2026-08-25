import { cloneDocument, type NodeDocument } from './model';

export interface DocumentCommand {
  readonly label: string;
  readonly before: NodeDocument;
  readonly after: NodeDocument;
}

export class CommandHistory {
  private undoStack: DocumentCommand[] = [];
  private redoStack: DocumentCommand[] = [];
  private current: NodeDocument;

  public constructor(document: NodeDocument) {
    this.current = cloneDocument(document);
  }

  private snapshot(): NodeDocument {
    return cloneDocument(this.current);
  }
  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public execute(label: string, after: NodeDocument): NodeDocument {
    const command = { label, before: this.current, after: cloneDocument(after) };
    this.current = command.after;
    this.undoStack.push(command);
    this.redoStack = [];
    return this.snapshot();
  }

  public get currentDocument(): NodeDocument {
    return this.snapshot();
  }

  public undo(): NodeDocument {
    const command = this.undoStack.pop();
    if (!command) return this.snapshot();
    this.current = command.before;
    this.redoStack.push(command);
    return this.snapshot();
  }

  public redo(): NodeDocument {
    const command = this.redoStack.pop();
    if (!command) return this.snapshot();
    this.current = command.after;
    this.undoStack.push(command);
    return this.snapshot();
  }
}
