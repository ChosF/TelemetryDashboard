# Design System: EcoVolt CCM

**Reference surface:** [eco-volt.org](https://eco-volt.org/)  
**Audit date:** July 22, 2026  
**Project ID:** Not applicable — this system was derived from the deployed EcoVolt landing page rather than a Stitch project.  
**Purpose:** Source of truth for extending the landing page's visual language into EcoVolt product surfaces, especially the telemetry dashboard.

## 1. Visual Theme & Atmosphere

EcoVolt's visual identity is **Swiss-engineered, data-driven, and motorsport precise**. It combines the restraint of an editorial grid with the urgency of live vehicle instrumentation. The experience should feel like a premium engineering artifact: dark, exact, calm under pressure, and punctuated by a single high-energy signal color.

The signature is the relationship between three elements:

- A near-black field with a barely visible 80-pixel engineering grid.
- Large, tightly set typography that creates decisive editorial hierarchy.
- Warm signal orange used sparingly for action, emphasis, and live energy.

The visual tone is **industrial and refined**, not futuristic decoration for its own sake. Premium quality comes from disciplined alignment, strong typography, careful density, exact spacing, and meaningful feedback. It does not come from glossy effects, excessive shadows, or ornamental glass panels.

### Experience principles

1. **Precision before decoration.** Every line, number, and accent must communicate structure or state.
2. **One dominant signal.** Orange establishes the primary focus; supporting colors remain quieter.
3. **Controlled density.** Marketing pages can breathe broadly, while operational screens may be dense, but both share the same hierarchy and grid logic.
4. **Glanceable under pressure.** A driver or pit operator must understand priority, state, value, and unit without studying the interface.
5. **Confident asymmetry.** Large editorial type, offset image or data blocks, and unequal column spans are preferable to repetitive centered cards.
6. **Context-specific character.** The interface should unmistakably belong to an electric race team, not a generic software dashboard.

### Memorable design motif

Use the **instrument-grid motif** consistently: faint structural grid lines, numeric section indexing, tabular telemetry, and occasional orange corner brackets. This is the system's differentiator and should be more memorable than any individual card treatment.

## 2. Color Palette & Roles

### Foundation surfaces

- **Circuit Black** (#0A0A0A) — Primary canvas, navigation backdrop, and deepest panel surface. This is the dominant color.
- **Instrument Charcoal** (#141414) — Secondary section and raised-panel surface. Use it to separate major zones without relying on shadows.
- **Graphite Layer** (#1E1E1E) — Tertiary nested surface for controls, chart wells, or selected groups.
- **Technical Slate** (#2A2A2A) — Strong divider, disabled surface, or compact control background. Use sparingly.
- **Signal White** (#FAFAFA) — Primary text, active icons, and high-contrast controls.
- **Warm Technical White** (#F5F5F0) — Optional light surface or softer light text when pure white would feel clinical.

### Brand and interaction

- **Voltage Orange** (#FF6B35) — Primary call to action, current selection, key emphasis, focus ring, and branded energy signal.
- **Hot Ember** (#FF4500) — Primary hover or pressed emphasis and the deep end of orange gradients.
- **Charged Orange** (#FF8F5C) — Lighter hover feedback, compact highlights, and scrollbar hover.
- **Deep Voltage Orange** (#E55A2B) — Reserved darker orange for pressed states or strong contrast.
- **Sunset Orange** (#FF7849) — Optional intermediate data-series tint; do not introduce it when the core orange is sufficient.

### Achievement accents

- **Machined Gold** (#D4A574) — Recognition, awards, and exceptional milestones.
- **Burnished Copper** (#B87333) — Supporting achievement gradient and heritage detail.
- **Bronze Metal** (#CD7F32) — Tertiary recognition state only.

These metallic colors are narrative accents, not general-purpose dashboard status colors.

### Operational data

- **Live Energy Green** (#22C55E) — Connected, active, healthy, or successful state.
- **Telemetry Teal** (#14B8A6) — Secondary live series, neutral-positive telemetry, or comparative data.
- **Signal Cyan** (#06B6D4) — Informational series, location, or secondary analytical context.

Orange is the brand/action color. Green, teal, and cyan carry operational meaning. Do not use orange for every chart series or every positive state.

### Contrast hierarchy

On dark surfaces, use Signal White at deliberate opacity tiers:

- **100%** — Primary values, headings, active labels.
- **60%** — Secondary navigation and supporting labels.
- **55%** — Long-form descriptive copy.
- **40%** — Brand eyebrow text and tertiary metadata.
- **35%** — Quiet captions, timestamps, and noncritical context.

Structural lines should remain subtle:

- **5% white** — Major section and navigation boundaries.
- **7–8% white** — Card outlines and internal rules.
- **20% white** — Deliberate outlined controls.
- **30–40% orange** — Active or hovered card outline.

Never use low-opacity text for essential telemetry, warnings, units required for interpretation, or interactive labels.

## 3. Typography Rules

### Primary family

**Plus Jakarta Sans** is the primary interface and editorial family. Its geometric construction supports the engineered tone while retaining enough warmth for the team's public identity.

- Display headlines: extra-bold or black, visually equivalent to 800–900.
- Interface headings: bold, 700–800.
- Body and navigation: regular to semibold, 400–600.
- Buttons and compact labels: bold, 700.

When implementing new surfaces, load every weight that is actually used. Do not depend on synthetic browser bolding.

### Data family

**Space Grotesk** is restricted to telemetry, counters, timestamps, coordinates, and compact technical metadata. Use tabular numerals so changing values remain optically stable. It is part of the existing identity, but it should not become a generic headline font.

### Scale and rhythm

- **Hero display:** Fluid 48–144 pixels, very tight 0.92 line height, negative 0.03-em tracking.
- **Major section headline:** Fluid 32–77 pixels, compressed 0.9 line height, negative 0.02-em tracking, often uppercase.
- **Panel title:** Fluid 22–40 pixels, 1.05 line height, negative 0.01-em tracking.
- **Large body:** Fluid 17–22 pixels, relaxed 1.65 line height.
- **Standard body:** 16 pixels with approximately 1.5 line height.
- **Section index and eyebrow:** Approximately 11 pixels, uppercase, widely spaced at 0.3 em.
- **Button label:** Approximately 14 pixels, uppercase, bold, with 0.08-em tracking.

Large headings should feel dense and architectural. Body copy should feel calm and readable. Compact labels should feel like instrumentation.

### Content conventions

- Keep telemetry values and their units visually connected, but give the value the dominant weight.
- Use sentence case for explanatory text and navigation.
- Use uppercase for actions, section labels, status captions, and short technical categories.
- Do not uppercase paragraphs, long field labels, error explanations, or dense table headings.
- Prefer short, specific labels such as “Battery voltage” over vague labels such as “Metric 01.”

## 4. Geometry, Depth & Materials

### Shape language

The default shape is **sharp and squared-off**. The live landing page uses zero-radius buttons, cards, panels, and navigation elements. Preserve that engineered geometry.

- Primary panels and cards: square corners.
- Buttons and inputs: square corners.
- Tags and compact controls: square or minimally softened only when touch affordance clearly benefits.
- Status indicators: circular dots are allowed because they represent lights, not containers.
- Orange corner brackets: 16-pixel arms with 2-pixel strokes for selected imagery, inspection zones, or special readouts.

Avoid turning the interface into a collection of rounded floating tiles.

### Depth

The system is predominantly flat. Depth comes from surface tone, borders, overlap, and motion rather than drop shadows.

- Base state: no shadow.
- Hoverable card: two-pixel lift, orange-tinted hairline border, and a nearly invisible orange wash.
- Fixed navigation: translucent Circuit Black at 80% with a restrained backdrop blur and a 5% white bottom rule.
- Modal or temporary overlay: deep black veil, strong spatial separation, and limited blur.

If a shadow is necessary for a floating safety-critical element, it must be broad, dark, and subtle. Decorative stacked shadows are outside the language.

## 5. Component Styling

### Primary buttons

- Voltage Orange background with Circuit Black text.
- Square geometry.
- Comfortable 16-pixel vertical and 32-pixel horizontal padding.
- Uppercase bold label with expanded tracking.
- Optional arrow or simple line icon aligned after the label.
- Hover moves toward Hot Ember and may use a single restrained light sweep.
- Focus uses a visible 2-pixel Voltage Orange outline with a 2-pixel offset.

### Secondary buttons

- Transparent dark background with a 1-pixel, 20% white outline.
- Signal White text.
- Hover may invert to a Signal White background with Circuit Black text.
- Secondary actions must never visually compete with the primary orange action.

### Cards and containers

- Circuit Black or Instrument Charcoal surface.
- One-pixel, 7–8% white border.
- No default shadow and no corner radius.
- Internal padding: 24 pixels for compact panels, 32 pixels for standard panels, up to 40 pixels for editorial feature panels.
- Hoverable cards may lift two pixels and move to a 30–40% orange border.
- Nested panels should use a surface change or rule, not another heavy frame.

### Navigation

- Fixed 80-pixel header.
- Circuit Black at 80% opacity with restrained blur.
- Maximum content width of 1600 pixels.
- Horizontal edge padding of 24 pixels on small screens and 48 pixels on large screens.
- Quiet navigation links with a two-pixel orange underline that grows from zero on hover.
- Mobile navigation becomes a full-screen, near-opaque black menu with large uppercase links.

### Section labels and metadata

- Begin with a numeric index when sequence matters.
- Use widely tracked uppercase text in Voltage Orange or Machined Gold.
- Pair with a short horizontal rule to make the label feel like a drawing annotation.
- Use Space Grotesk and tabular numerals for timestamps, session IDs, coordinates, and measurements.

### Inputs, filters, and selectors

The landing page does not establish a form pattern. The approved dashboard extension is:

- Circuit Black or Graphite Layer background.
- One-pixel, low-contrast white border.
- Square geometry and a minimum 44-pixel target height.
- Persistent label outside the field; placeholder text is never the only label.
- Orange border and focus outline when active.
- Selected states use an orange rule or compact fill, not a large glow.
- Disabled controls remain legible and visibly noninteractive.

### Charts, maps, and telemetry panels

- Treat charts as instruments, not illustrations.
- Use faint grid lines and quiet axes so the data remains dominant.
- Use Signal White for the primary series; use teal, cyan, and green for secondary operational series.
- Reserve orange for selection, threshold emphasis, active trace, or the single most important series.
- Keep units visible at the axis, tooltip, or value label.
- Tooltips use sharp Instrument Charcoal panels with a fine border and tabular values.
- Maps should use a dark, desaturated base so route and vehicle state carry the visual focus.

### Icons

- Prefer simple line icons with consistent stroke weight.
- Icons support labels; they do not replace ambiguous actions.
- Avoid multicolored icon bubbles, decorative emoji, and unrelated illustration styles.

## 6. Layout Principles

### Grid and frame

- Maximum content width: 1600 pixels.
- Desktop foundation: 12-column grid.
- Outer gutters: 24 pixels on mobile and 48 pixels on large screens.
- Typical content gaps: 32 pixels on mobile and 48 pixels on desktop.
- Marketing section spacing: 96 pixels on small screens and 128 pixels on large screens.
- Background engineering grid: 80 by 80 pixels with orange lines at roughly 2.5% opacity.

Alignment should be exact enough that panel edges, chart axes, section labels, and values visibly share the same grid.

### Dashboard density

The dashboard should translate the landing language rather than copy its marketing proportions:

- Preserve the dark canvas, sharp geometry, typography, grid, and accent logic.
- Reduce empty vertical space in favor of an operator-focused information hierarchy.
- Give the most important live state the largest uninterrupted region.
- Group related measurements by task and decision, not merely by data source.
- Use progressive disclosure for advanced controls and historical detail.
- Do not force every metric into an identical card.

### Responsive behavior

The audited landing page collapses cleanly to a 390-pixel viewport without horizontal overflow. New product surfaces should maintain the same confidence:

- Stack the major grid at mobile widths.
- Keep primary status and core live values above secondary analysis.
- Allow tables to transform into labeled rows or controlled horizontal regions rather than shrinking text.
- Preserve a minimum 44-pixel interactive target.
- Reduce headline scale, not hierarchy.
- Hide only genuinely secondary metadata; never hide state, units, or safety-relevant context.

## 7. Motion & Interaction

Motion should feel calibrated, mechanical, and purposeful.

- Major reveal: approximately 700–900 milliseconds with a confident ease-out curve.
- Standard hover or state transition: approximately 300–350 milliseconds.
- Button light sweep: approximately 500 milliseconds.
- Stagger related elements in short 100–150 millisecond intervals.
- Use one coordinated entrance sequence per surface rather than many unrelated animations.

For live telemetry:

- Do not animate every sample or make values bounce.
- Use restrained transitions for meaningful state changes, connection events, selection, and threshold crossings.
- Preserve numeric stability with tabular figures.
- Never let animation delay access to live data or controls.
- Honor reduced-motion preferences by effectively removing transitions and animation.

## 8. Information Hierarchy for Operational Screens

Every dashboard view should establish three layers:

1. **Immediate state** — connection, session, safety, speed, power, and any condition requiring action.
2. **Operational context** — trends, route, efficiency, component state, and recent change.
3. **Analysis and control** — historical comparison, filters, exports, settings, and secondary tools.

Use size, position, contrast, and whitespace before using more color. Orange should identify the focal action or selected state, not compensate for weak hierarchy.

All operational surfaces must account for:

- Live and stale data.
- Connected, reconnecting, and offline states.
- Loading, empty, partial, error, and permission-limited states.
- Threshold warnings with text or icon reinforcement, never color alone.
- Explicit units and timestamp freshness.

## 9. Accessibility & Usability

- Maintain strong contrast for essential values and labels.
- Retain the existing visible orange focus treatment.
- Ensure keyboard focus order follows the visual reading order.
- Use at least 44 by 44 pixels for touch targets.
- Never communicate status only through hue; pair color with a label, icon, pattern, or shape.
- Provide reduced-motion behavior.
- Keep charts understandable through labels, tooltips, and an accessible tabular or textual equivalent.
- Avoid low-opacity text below practical readability for critical content.
- Use plain, direct language for failures and recovery actions.

## 10. Directional Guardrails

### Do

- Commit to the Swiss-industrial telemetry direction with precision.
- Use dominant dark foundations and one sharp orange accent.
- Create atmosphere through the faint engineering grid, material contrast, and typography.
- Use asymmetry, offset columns, and deliberate spans where they improve hierarchy.
- Make the interface memorable through the instrument-grid motif.
- Match visual complexity to purpose: restrained for monitoring, richer for storytelling.

### Do not

- Introduce purple gradients, neon cyberpunk effects, or generic blue SaaS styling.
- Use indiscriminate glassmorphism, glowing borders, or frosted cards.
- Round every panel and control.
- Place every metric in an identical floating card.
- Use orange on every chart series, icon, heading, and status.
- Add decorative motion to high-frequency telemetry.
- Use generic placeholder copy, arbitrary stock imagery, or unrelated icon styles.
- Sacrifice readability or task speed for dramatic marketing composition.

## 11. Language for Future Design Generation

When prompting Stitch or another design tool, describe the system in visual and functional language:

> Create a premium Swiss-engineered telemetry interface on Circuit Black (#0A0A0A), structured by a barely visible 80-pixel orange engineering grid. Use sharp, squared-off Instrument Charcoal (#141414) panels with fine low-contrast borders, decisive Plus Jakarta Sans hierarchy, and stable Space Grotesk tabular telemetry. Reserve Voltage Orange (#FF6B35) for the primary action, current selection, and one dominant live signal. Keep the composition dense but calm, asymmetric where useful, and free of rounded SaaS cards, decorative glass, and gratuitous shadows.

For refinement, change one design decision at a time and name both the component and intended outcome. Examples:

- “Increase the separation between immediate vehicle state and secondary analysis while preserving the 12-column instrument grid.”
- “Reduce orange usage in the charts so it identifies only the selected trace and threshold crossings.”
- “Make the control group feel more like a precise instrument panel using square geometry, fine white rules, and clearer label hierarchy.”

## 12. Audit Basis

This guide synthesizes:

- The deployed landing page at [eco-volt.org](https://eco-volt.org/), inspected at desktop and 390-pixel mobile widths.
- The repository landing structure in `index.html`.
- The exact visual tokens and interaction rules in `public/landing.css`.
- The installed `design-md` skill's semantic design-system structure.
- The `frontend-design` guidance to pursue a clear, memorable aesthetic direction; avoid generic generated-interface conventions; and match implementation complexity to the chosen visual concept.
- The [Stitch Effective Prompting guide](https://stitch.withgoogle.com/docs/learn/prompting/).

When this document and the implementation diverge, verify the deployed landing page and its current source, then update this guide deliberately rather than allowing the system to drift.

