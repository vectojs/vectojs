import { Markdown, PRESET_THEMES, type MarkdownThemePresetName } from '@vectojs/markdown';
import {
  DOCUMENT_SCROLL_PHYSICS,
  Dropdown,
  ScrollView,
  Stack,
  Text,
  TextArea,
  Toggle,
  UIComponent,
} from '@vectojs/ui';
import type { IRenderer } from '@vectojs/core';

export type MarkdownAppTheme = MarkdownThemePresetName;

export interface MarkdownAppOptions {
  initialContent?: string;
  initialTitle?: string;
  width?: number;
  height?: number;
  theme?: MarkdownAppTheme;
  /** Show the source editor. Defaults to `true`. */
  editable?: boolean;
  /** Allow native selection in the rendered preview. Defaults to `true`. */
  selectable?: boolean;
  /** Show the toolbar. Defaults to `true`. */
  showToolbar?: boolean;
  /** Virtualize large static documents in the preview. Defaults to `true`. */
  virtualize?: boolean | { overscan?: number };
  onLinkClick?: (url: string) => void;
  onChange?: (content: string) => void;
}

// Single source of truth with @vectojs/markdown: a preset added there shows up
// here automatically instead of compiling but silently no-oping in setTheme.
const THEMES = Object.keys(PRESET_THEMES) as MarkdownThemePresetName[];

/**
 * A standalone canvas-native Markdown reader and source workbench.
 *
 * `MarkdownApp` owns the composition and document state while `Markdown` owns
 * parsing, layout, selection, code blocks, math, and virtualization. The source
 * field uses `TextArea` so IME, clipboard, undo, and native selection remain
 * browser-native through VectoJS's projected input layer.
 */
export class MarkdownApp extends UIComponent {
  public readonly source: TextArea;
  public readonly preview: Markdown;
  public readonly previewScroll: ScrollView;
  public readonly themePicker: Dropdown;
  public readonly editToggle: Toggle;
  private readonly toolbar: Stack | null;
  public title: string;
  public theme: MarkdownAppTheme;
  public editable: boolean;
  public toolbarHeight = 48;
  public padding = 16;
  private readonly onContentChange?: (content: string) => void;
  private readonly toolbarTitle: Text | null;

  constructor(opts: MarkdownAppOptions = {}) {
    super();
    this.width = opts.width ?? 960;
    this.height = opts.height ?? 680;
    this.title = opts.initialTitle ?? 'Markdown workspace';
    this.theme = opts.theme ?? 'githubDark';
    this.editable = opts.editable ?? true;
    this.onContentChange = opts.onChange;
    this.interactive = false;

    const content = opts.initialContent ?? '# Untitled\n\nStart writing Markdown.';
    this.source = new TextArea({
      width: 320,
      height: 500,
      value: content,
      placeholder: 'Write Markdown...',
      font: '15px ui-monospace, monospace',
      bg: '#0f172a',
      border: '#334155',
      onChange: (value) => this.setContent(value),
    });
    this.preview = new Markdown(content, {
      maxWidth: 560,
      theme: this.theme,
      selectable: opts.selectable ?? true,
      virtualize: opts.virtualize ?? true,
      onLinkClick: opts.onLinkClick,
    });
    this.previewScroll = new ScrollView({
      width: 560,
      height: 580,
      scrollPhysics: DOCUMENT_SCROLL_PHYSICS,
    });
    this.previewScroll.add(this.preview);

    this.themePicker = new Dropdown(THEMES, {
      value: this.theme,
      label: 'Preview theme',
      width: 164,
      height: 34,
      font: '13px sans-serif',
      onChange: (value: string) => this.setTheme(value as MarkdownAppTheme),
    });
    this.editToggle = new Toggle({
      checked: this.editable,
      label: 'Edit source',
      width: 40,
      height: 22,
      font: '13px sans-serif',
      onChange: (value) => this.setEditable(value),
    });

    if (opts.showToolbar ?? true) {
      this.toolbar = new Stack({ direction: 'horizontal', gap: 16, align: 'center' });
      this.toolbarTitle = new Text(this.title, { font: '600 16px sans-serif', color: '#e2e8f0' });
      this.toolbar.add(this.toolbarTitle);
      this.toolbar.add(this.editToggle);
      this.toolbar.add(this.themePicker);
      this.add(this.toolbar);
    } else {
      this.toolbar = null;
      this.toolbarTitle = null;
    }
    this.add(this.source);
    this.add(this.previewScroll);
    this.layoutApp();
  }

  public setContent(content: string): this {
    if (this.source.value !== content) this.source.value = content;
    this.preview.setContent(content);
    this.onContentChange?.(content);
    this.layoutApp();
    return this;
  }

  public setTheme(theme: MarkdownAppTheme): this {
    // Fail loud on unknown names instead of silently no-oping, matching the
    // convention everywhere else in these packages (styles throws on unknown
    // tokens/properties). The type keeps valid presets out of TS callers; this
    // guards JS callers and casts.
    if (!THEMES.includes(theme)) {
      throw new TypeError(
        `@vectojs/markdown-app: unknown theme '${String(theme)}' — valid presets: ${THEMES.join(', ')}`,
      );
    }
    if (this.theme === theme) return this;
    this.theme = theme;
    // Sanctioned re-theme path: Markdown.setTheme resolves the preset, carries
    // blockGap onto the content Stack, and rebuilds via setContent (#781 fix).
    this.preview.setTheme(theme);
    this.scene?.markDirty();
    return this;
  }

  public setEditable(editable: boolean): this {
    if (this.editable === editable) return this;
    this.editable = editable;
    this.editToggle.checked = editable;
    this.layoutApp();
    return this;
  }

  public setTitle(title: string): this {
    this.title = title;
    this.toolbarTitle?.setText(title);
    this.scene?.markDirty();
    return this;
  }

  public override render(_r: IRenderer): void {}

  /** Resize the workbench and reflow the retained editor and preview entities. */
  public setSize(width: number, height: number): this {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.layoutApp();
    // Child relayout paths early-return on unchanged geometry (e.g. Markdown
    // `setMaxWidth`) and never dirty the scene themselves.
    this.scene?.markDirty();
    return this;
  }

  private layoutApp(): void {
    const toolbarVisible = this.toolbar !== null;
    const contentY = toolbarVisible ? this.toolbarHeight : 0;
    const contentHeight = Math.max(1, this.height - contentY);
    const contentWidth = Math.max(1, this.width - this.padding * 2);
    const gap = this.editable ? 16 : 0;
    const sourceWidth = this.editable
      ? Math.min(
          Math.max(220, Math.floor(contentWidth * 0.38)),
          Math.max(1, contentWidth - gap - 1),
        )
      : 0;
    const previewWidth = Math.max(1, contentWidth - sourceWidth - gap);

    if (toolbarVisible) {
      this.toolbar!.setPosition(this.padding, 0);
      this.toolbar!.width = contentWidth;
      this.toolbar!.height = this.toolbarHeight;
    }
    this.source.interactive = this.editable;
    this.source.opacity = this.editable ? 1 : 0;
    this.source.width = sourceWidth;
    this.source.height = contentHeight;
    this.source.setPosition(this.padding, contentY);

    this.previewScroll.width = previewWidth;
    this.previewScroll.height = contentHeight;
    this.previewScroll.setPosition(this.padding + sourceWidth + gap, contentY);
    this.preview.setMaxWidth(Math.max(1, previewWidth - this.padding * 2));
    this.previewScroll.updateContentSize();
  }
}
