# High-Level UI Components

The `@vecto-ui/ui` package provides a set of ready-to-use, highly styled mathematical components. These components are designed with a **Cyberpunk / Glassmorphism** aesthetic out of the box, utilizing our signature Cyan and Magenta color language.

## Available Components

### 1. `Toggle`
A highly interactive iOS-style switch rendered entirely on the GPU.

```typescript
import { Toggle } from '@vecto-ui/ui';

const myToggle = new Toggle({
  label: 'Dark Mode',
  checked: false,
  color: '#ffffff',
  accent: '#ff00aa',
  onChange: (checked) => {
    // React to the toggle state change
  }
});
```

**Under the Hood:**
When you create a `Toggle`, VectoUI generates an invisible `<div role="switch" aria-checked="false">` in the A11y Shadow DOM. When a screen reader clicks the invisible DOM element, the event is mathematically proxied back into the Canvas, flipping the toggle and triggering the smooth transition animation.

### 2. `Input`
A revolutionary Canvas-based text input field.

```typescript
import { Input } from '@vecto-ui/ui';

const searchInput = new Input({
  placeholder: 'Search node...',
  font: '14px "Outfit", sans-serif',
  color: '#fff',
  width: 250,
  height: 40,
  onChange: (text) => {
    // Handle typing events in real-time
  }
});
```

**The Input Magic:**
Text rendering on Canvas is notoriously difficult because you lose native OS features like IME (Input Method Editor for Chinese/Japanese), text selection highlighting, and native keyboard popups on mobile.

VectoUI's `Input` solves this by perfectly aligning a transparent native HTML `<input>` directly over the mathematical coordinates of the Canvas element. 
- You type into the native transparent DOM input.
- VectoUI reads the DOM input's value in real-time and renders the typography beautifully on the GPU Canvas using sub-pixel anti-aliasing.
- The user gets native typing feel, but 100% GPU-accelerated styling!

### 3. `Panel`
A Glassmorphism container. It applies mathematically calculated Blur and Opacity effects.

```typescript
import { Panel } from '@vecto-ui/ui';

const sidebar = new Panel({
  width: 300,
  height: 800,
  background: 'rgba(25, 25, 30, 0.6)', // Glass
  borderColor: 'rgba(255, 255, 255, 0.1)',
  borderRadius: 16
});
```

*More components like `Button`, `Dropdown`, and `ScrollView` are currently in active development on the Roadmap.*
