# terminal-canvas-ui Specification

## Purpose

Defines the terminal canvas that renders the workflow graph live during a run: node status rendering, keyboard-first navigation with mouse as an optional enhancement, per-node detail views with streamed output and activity logs, and automatic layout with viewport panning.
## Requirements
### Requirement: Live graph rendering
The system SHALL render the loaded workflow graph as boxes connected by edges in the terminal, updating each node's visual status (`idle`, `running`, `waiting`, `done`, `error`, `skipped`) as execution status events arrive. Loop-back edges SHALL be rendered on the cards they connect rather than as drawn paths, and a node that has run more than once SHALL show how many attempts it has taken.

#### Scenario: Node status changes during a run
- **WHEN** a node transitions from `running` to `done` during execution
- **THEN** the terminal UI SHALL update that node's rendered status within one render cycle without requiring a manual refresh

#### Scenario: Skipped nodes are visually distinct
- **WHEN** nodes are set to `skipped` because an upstream node errored, or because an edge condition that guards them did not hold
- **THEN** the UI SHALL render them distinctly from `idle` nodes, so the user can tell "will not run" from "not yet started"

#### Scenario: A rejected gate does not read as a success
- **WHEN** an Approval-Gate reaches `done` with a recorded decision of `rejected`
- **THEN** the UI SHALL render it distinctly from an approved gate, so its terminal status alone does not present the rejection as a successful outcome

#### Scenario: Loop-back edges are carried by the cards, not drawn between them
- **WHEN** the workflow declares a loop-back edge
- **THEN** the UI SHALL badge both of the nodes it connects, distinctly from any forward-edge rendering, and SHALL NOT draw a path between them
- **AND** the graph SHALL occupy the same rows it would if that loop-back were not declared, however many loop-backs the workflow declares

A loop-back is a long-range backward edge in a left-to-right layout, so drawing one means a run spanning most of the canvas plus risers crossing whatever lies between. That cost is paid per loop-back and grows with the graph, which is what made a workflow unreadable as its node count rose. Naming the node at the other end carries the same information at no spatial cost: the badge is read rather than traced.

#### Scenario: A loop-back badge names the node at its other end
- **WHEN** a node is one end of exactly one loop-back
- **THEN** its badge SHALL name the node at the other end, and SHALL distinguish the direction the loop runs
- **WHEN** a node is an end of several loop-backs and none has fired
- **THEN** its badge MAY give their number in place of their names, which no card is wide enough to hold

#### Scenario: A loop-back badge degrades before it truncates a node's identity
- **WHEN** a card is too narrow to render a node's loop-back badge in full
- **THEN** the UI SHALL fall back to a shorter form of the badge
- **AND** the node's own identity SHALL NOT lose room to the badge at any card density

#### Scenario: A node re-run by a loop-back shows its attempt count
- **WHEN** a node has been executed more than once because of a loop-back
- **THEN** its rendered box SHALL indicate the current attempt number, and a node on its first attempt SHALL show no such indicator

#### Scenario: Reset nodes return to their pre-run appearance
- **WHEN** a loop-back resets a segment of previously completed nodes
- **THEN** those nodes SHALL render as `idle` again within one render cycle, so the user sees the loop take effect rather than a frozen stale status

#### Scenario: The active loop is identifiable
- **WHEN** a loop-back fires
- **THEN** the UI SHALL indicate which loop-back edge fired and which node triggered it, so the user can tell why execution moved backwards
- **AND** it SHALL do so in the badge's text rather than by colour alone, so the answer survives a washed-out terminal theme and a reader who cannot separate the two shades
- **WHEN** a node is the target of several loop-backs and one of them fires
- **THEN** its badge SHALL name that loop's source in place of counting them all, because which loop moved the run backwards is what a count hides

#### Scenario: Focus identifies a loop's other end without drawing it
- **WHEN** focus rests on a node that is an end of a loop-back
- **THEN** the UI SHALL distinguish the badge on the node at the other end from the badges of nodes not on that loop, so the loop's reach is identifiable without a drawn path

### Requirement: Keyboard-first navigation
The system SHALL support navigating between nodes and performing all node interactions (expand, approve, reject, choose the node's model) via keyboard alone, independent of mouse support.

#### Scenario: Navigating and expanding a node via keyboard
- **WHEN** the user presses Tab to move focus between nodes and Enter on a focused node
- **THEN** the system SHALL expand that node's detail view without requiring any mouse input

#### Scenario: Choosing a node's model via keyboard
- **WHEN** the user presses the model-picker key on a focused node and confirms a selection with the keyboard
- **THEN** the system SHALL apply that model to the node without requiring any mouse input

### Requirement: Mouse interaction as enhancement
The system SHALL support mouse click to focus or expand a node and mouse drag to reposition a node, when the terminal emulator reports mouse events, without being required for any workflow action. Positions changed by dragging apply to the current session only and SHALL NOT be written back to the workflow file. Changes the user makes to a node's configuration, such as its model, are not viewport state and ARE written back to the workflow file.

#### Scenario: Terminal without mouse reporting support
- **WHEN** the terminal emulator does not send mouse events
- **THEN** the system SHALL remain fully operable via keyboard alone, with no feature gated behind mouse input

#### Scenario: Dragged position is not persisted
- **WHEN** the user drags a node to a new position and the run ends
- **THEN** `.flow-code/workflow.yaml` SHALL be unmodified, and a subsequent run SHALL lay the graph out from scratch

#### Scenario: Configuration change is persisted
- **WHEN** the user changes a node's model during a run and the run ends
- **THEN** `.flow-code/workflow.yaml` SHALL carry that node's new `config.model`, and a subsequent run SHALL start from it

### Requirement: Node detail view
The system SHALL provide an expandable detail view per node showing its current status, config summary, the model it resolves to, live streamed output, and its tool-call activity log. When a node ran more than one agent — subagents, or Worktree-Agent instances — the activity log SHALL be presented so that each agent's calls are attributable rather than interleaved into a single undifferentiated sequence.

#### Scenario: Expanding a running node
- **WHEN** the user expands a node that is currently `running`
- **THEN** the system SHALL display that node's live streamed output in the detail view, updating as new output arrives

#### Scenario: Viewing what the agent actually ran
- **WHEN** the user expands any node that has executed tool calls
- **THEN** the detail view SHALL show that node's activity log — one row per tool call with its timestamp, tool name, command or input summary, permission decision, and exit status — appended live as new calls occur

#### Scenario: A node that ran several agents
- **WHEN** the user expands a node whose activity log contains entries from more than one agent
- **THEN** the detail view SHALL make each row's originating agent identifiable, so two concurrent agents' sequences can be told apart

#### Scenario: A node that ran exactly one agent
- **WHEN** the user expands a node whose every entry came from its own session
- **THEN** the detail view SHALL NOT spend panel width on attribution that would distinguish nothing

#### Scenario: Denied action is visible in the node
- **WHEN** the capability harness denies a tool call for a node
- **THEN** that denial SHALL appear in the node's activity log marked as denied, naming the missing capability, and the node SHALL carry a visible indicator that at least one action was blocked

#### Scenario: Seeing which model a node runs on
- **WHEN** the user expands an agent-driven node
- **THEN** the detail view SHALL name the model that node resolves to and where that model came from

#### Scenario: Output line wider than the panel
- **WHEN** a node's streamed output contains a line wider than the detail panel's inner width
- **THEN** the system SHALL wrap that line onto further rows so its full text is readable, rather than cutting it off at the panel's right edge

### Requirement: Discuss transcript formatting
The Discuss panel SHALL render the agent's markdown as terminal styling rather than as literal markup, wrapping every row to the panel's inner width so no text is cut off at its right edge. The user's own messages SHALL be shown exactly as typed.

#### Scenario: Agent replies in markdown
- **WHEN** an agent message in the Discuss transcript contains markdown — headings, list items, fenced or inline code, emphasis, block quotes, or links
- **THEN** the panel SHALL render the styling those markers denote and SHALL NOT display the markers themselves

#### Scenario: User types markdown characters
- **WHEN** the user's own message contains characters that are markdown markers
- **THEN** the panel SHALL display that message verbatim, since the user typed those characters deliberately

#### Scenario: Transcript line wider than the panel
- **WHEN** a transcript message is wider than the panel's inner width
- **THEN** the panel SHALL wrap it onto further rows, breaking between words where possible and never inside a styled span's word, and SHALL hard-break only a single token wider than the panel

### Requirement: Graph layout and viewport
The system SHALL arrange nodes automatically in a left-to-right layout derived from the graph's forward-edge dependency order, and SHALL remain usable when the graph does not fit the terminal viewport. Loop-back edges SHALL NOT participate in layer assignment.

#### Scenario: Graph is laid out without explicit positions
- **WHEN** a workflow file declares nodes and edges with no position information
- **THEN** the system SHALL compute a left-to-right arrangement in which every node is drawn after all of its forward-edge dependencies

#### Scenario: Graph exceeds the terminal size
- **WHEN** the rendered graph is larger than the terminal viewport
- **THEN** the system SHALL allow the user to pan the viewport via keyboard, and focusing a node via keyboard navigation SHALL bring that node into view

#### Scenario: Loop-back edges do not distort the layout
- **WHEN** a workflow declares a loop-back edge from a node to one of its ancestors
- **THEN** layer assignment SHALL be computed over the forward edges alone, so the presence of the loop-back changes neither the layer any node lands in nor its order within that layer
- **AND** the loop-back SHALL claim no rows of its own, however many the workflow declares

A loop-back's badge does occupy columns on the two cards it touches, which can widen them — that is a card-sizing effect, not a layout one, and it is bounded by the badge rather than growing with the graph. Layer assignment, ordering, and the graph's height are all untouched by a loop-back's presence.

### Requirement: Attempt history in the node detail view
A node's detail view SHALL surface its attempt history when it has run more than once, so the user can compare what changed between attempts without leaving the UI.

#### Scenario: Inspecting a re-run node
- **WHEN** the user expands the detail view of a node that has been executed more than once
- **THEN** the view SHALL show the number of attempts and the terminal status of each prior attempt

#### Scenario: Detail view of a first-attempt node is unchanged
- **WHEN** the user expands the detail view of a node that has run at most once
- **THEN** the view SHALL show no attempt history section

### Requirement: Delegation is visible on the node card
A node running subagents SHALL indicate as much on its card while it runs, so that a node delegating work is distinguishable from one working alone without opening its detail view. The workflow graph itself SHALL continue to show exactly one box per workflow node; subagents SHALL NOT be rendered as nodes on the canvas.

#### Scenario: A node is running subagents
- **WHEN** a node has one or more subagents in flight
- **THEN** its card SHALL show how many, alongside the indicators it already carries

#### Scenario: Subagents do not become graph nodes
- **WHEN** a node spawns any number of subagents
- **THEN** the canvas SHALL still render one box for that node, and the graph's shape SHALL be unchanged from the workflow the user authored

#### Scenario: Card too small for the indicator
- **WHEN** the card is drawn at a density that has no room for the delegation indicator
- **THEN** the indicator SHALL be omitted rather than displacing the node's status or identity

### Requirement: The viewer reports which enforcement tier a run ran under
The UI SHALL indicate which enforcement tier the run it is displaying ran under — flow-code's engine executing it, a host session with flow-code's enforcement active, or self-reporting with no enforcement. The three carry materially different guarantees, and rendering them identically would present a graph as meaning more than it does for two of them.

#### Scenario: Watching a run driven from a host session
- **WHEN** the viewer is attached to a run whose run-state records a host-session tier
- **THEN** the UI SHALL indicate that tier distinctly from an engine-driven run, and SHALL make the guarantees that tier lacks discoverable without leaving the viewer

#### Scenario: Watching a self-reported run
- **WHEN** the viewer is attached to a run whose run-state records no enforcement
- **THEN** the UI SHALL indicate that the run's contents are self-reported and unverified

#### Scenario: Guarantees that did not apply are not implied
- **WHEN** the viewer displays a run whose tier does not provide token accounting or capability enforcement
- **THEN** it SHALL present those figures as unavailable rather than as zero, and SHALL NOT display capability-denial indicators as though a harness had produced them

#### Scenario: A run whose tier changed mid-run
- **WHEN** the viewer is attached to a run whose enforcement tier changed while it was running
- **THEN** the UI SHALL report the run at its weakest recorded tier rather than at the tier it opened under

#### Scenario: Watching an engine-driven run is unchanged
- **WHEN** the viewer is attached to a run driven by `flow-code run`
- **THEN** the UI SHALL present it exactly as it did before this change, with no tier indication beyond what it showed before

### Requirement: The read-only viewer is a command with a defined surface
The system SHALL provide a viewer command that renders a run it is not driving. The viewer SHALL attach to a run without loading the project's workflow file, SHALL refuse every action that would modify the run or the project, and SHALL keep following the repository rather than only the run it first attached to.

This requirement exists because the run document's rules — who may write it, what a reader may conclude about its driver, what an unnamed attach resolves to — are specified against the *document*, and a specification of the document is not a specification of the command that reads it.

#### Scenario: Attaching needs nothing but the run
- **WHEN** the viewer attaches to a run while the project's workflow file is absent, unreadable, or has been replaced
- **THEN** it SHALL render the graph the run recorded, and SHALL NOT fail or fall back to the workflow file

#### Scenario: Pinning to one run
- **WHEN** the viewer is given a run id
- **THEN** it SHALL follow that run and no other, and SHALL report a run id that does not exist rather than silently following a different run

#### Scenario: A run that starts after the viewer is open
- **WHEN** the viewer is opened with no run id and a run begins afterwards
- **THEN** it SHALL attach to that run without being restarted

#### Scenario: Every editing action is unavailable
- **WHEN** a user invokes an action that would change the run or the project from inside the viewer
- **THEN** the action SHALL be unavailable rather than attempted, and the viewer SHALL make its read-only nature visible without the user having to discover it by trying

#### Scenario: Leaving the viewer does not disturb the run
- **WHEN** the viewer is closed, by any means
- **THEN** the run it was watching SHALL be unaffected, and its document SHALL be byte-identical to what it would have been had the viewer never attached

### Requirement: Structured node output is rendered as prose

A node whose entire session reply is a JSON object — Spec, Validate, Review, and a discussion's closing turn — SHALL have its parsed output presented in the detail view as styled prose, using the same markdown rendering the Discuss transcript and the approval gate use, rather than as plain unstyled lines or as the raw JSON it arrived in. Where the same output is also shown at an Approval-Gate, the two views SHALL agree: a reader SHALL NOT have to reconcile two renderings of one artifact.

#### Scenario: A finished Spec node is expanded
- **WHEN** the user expands a Spec node that has completed
- **THEN** the detail view SHALL show its title, the path it wrote, its requirements and its acceptance criteria with markdown styling applied — criterion ids emphasized, list items as list items — and SHALL NOT display the markdown markers themselves

#### Scenario: The same spec seen at the gate and in the node
- **WHEN** a spec is shown both as a document at an Approval-Gate and in the Spec node's detail view
- **THEN** the two SHALL render the same content through the same path, so approving at the gate and reading at the node cannot disagree about what the spec says

#### Scenario: Output that has not parsed yet
- **WHEN** a node's reply is still streaming, or its output did not parse into the shape its type expects
- **THEN** the detail view SHALL fall back to the raw transcript rather than a blank or half-populated block, as it does today

