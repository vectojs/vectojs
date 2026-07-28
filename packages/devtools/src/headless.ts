export {
  buildTreeModel,
  findEntityAt,
  describeEntity,
  pickInScene,
  type DevtoolsTreeNode,
} from './model';
export { inspectEntity, entityPath, textPreviewOf, type EntityInfo } from './inspect';
export {
  createEventTrace,
  EventTrace,
  type EventTraceEntry,
  type EventTraceModifiers,
  type EventTraceOptions,
  type EventTraceSource,
  type EventTraceType,
} from './eventTrace';
export {
  captureSnapshot,
  diffSnapshots,
  type SceneSnapshot,
  type SnapshotNode,
  type SnapshotDiff,
} from './snapshot';
export {
  auditScene,
  auditTree,
  type AuditFinding,
  type AuditKind,
  type AuditOptions,
} from './audit';
export {
  auditSceneSelection,
  auditEntitySelection,
  type SelectionAuditFinding,
  type SelectionAuditOptions,
} from './selectionAudit';
export {
  diagnoseDirty,
  type DirtyCause,
  type DirtyDiagnosis,
  type DirtyDiagnosisOptions,
} from './dirtyDiagnosis';
export {
  explainHitTest,
  formatHitExplanation,
  type HitCandidate,
  type HitExplanation,
  type HitVerdict,
} from './hitExplain';
export {
  a11yReadingOrder,
  auditA11y,
  inspectA11y,
  type A11yAuditKind,
  type A11yAuditOptions,
  type A11yFinding,
  type A11yInfo,
} from './a11yInspect';
export {
  auditMarkdownStreaming,
  formatMarkdownStream,
  inspectMarkdownStream,
  isMarkdownEntity,
  markdownStreamAudit,
  markdownStreamInspector,
  type MarkdownStreamInfo,
} from './markdownInspect';
export {
  auditTextShaping,
  formatTextInspection,
  inspectText,
  isTextEntity,
  shapeProbe,
  textInspector,
  type TextGlyphInfo,
  type TextInspection,
} from './textInspect';
export {
  clearDevtoolsPlugins,
  devtoolsPlugins,
  pluginCommands,
  pluginInspectors,
  pluginInspectorsFor,
  registerDevtoolsPlugin,
  runPluginAudits,
  runPluginCommand,
  runPluginInspector,
  type DevtoolsPlugin,
  type PluginAudit,
  type PluginCommand,
  type PluginContext,
  type PluginFinding,
  type PluginInspector,
  type PluginRow,
} from './plugin';
export {
  formatHighlightGeometry,
  highlightGeometry,
  sampleHitRegion,
  type HighlightGeometryOptions,
  type HighlightLayer,
  type HighlightLayerKind,
  type HighlightPolygon,
} from './highlightGeometry';
