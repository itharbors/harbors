# Kit Manager Error Details Design

## Goal

Preserve actionable Kit Manager failures across the runtime, IPC, preload, and renderer boundaries, then show a concise error summary with expandable technical details instead of collapsing failures to `Kit Manager operation failed`.

## Error model

The IPC response remains a plain structured object. A failed operation carries:

- a stable uppercase error `code`;
- a bounded user-facing `message`;
- an optional bounded `causes` array containing sanitized causal messages in outer-to-inner order.

Messages must be non-empty strings without control characters, each capped at 240 characters. The causal list is capped at four entries and contains no stacks, arbitrary object properties, or serialized secrets. Unknown thrown values retain the generic fallback.

Runtime activation must not discard the validation exception. `finalizePendingKitActivations` records a sanitized failure on its internal outcome, and the live replacement path attaches that failure as the cause of `KIT_RUNTIME_APPLY_FAILED`. This preserves errors such as a missing packaged resource while retaining the existing rollback and bad-version behavior.

## Boundary behavior

`kit-manager-ipc` serializes the safe error shape. The preload validates the response fields, reconstructs an `Error`, and exposes only the code and causal messages needed by the renderer. Malformed responses fall back to `OPERATION_FAILED` without rendering attacker-controlled structures.

The renderer shows the top-level message in the existing alert region. When a code or cause is available, it adds a native expandable details block containing the error code and ordered root-cause messages. Text is inserted with `textContent`; HTML and stack traces are never rendered.

## User experience

The collapsed state remains compact and accessible. The alert announces the summary once. The technical detail control is keyboard accessible, uses the native disclosure interaction, and labels the section in Chinese. Successful operations clear all prior detail state.

For the Agent Guard incident, the user should see the runtime restoration summary and, after expanding details, the concrete missing `policy-v1.json` failure rather than a generic operation error.

## Validation

Add focused tests at each boundary:

- startup activation retains the original validation failure on its outcome;
- IPC sanitizes codes/messages/causes and bounds malformed or oversized input;
- preload reconstructs the validated error detail shape and rejects malformed fields;
- renderer creates, clears, and accessibly exposes the expandable details without HTML injection;
- an acceptance path carries a real nested runtime failure end to end.

Run the focused Node tests, Kit Manager acceptance tests, desktop-oriented test gate, and the repository finish workflow.

## Boundaries

- Do not expose JavaScript stacks or arbitrary exception properties.
- Do not change rollback, bad-version, or install transaction semantics.
- Do not couple this client fix to Agent Guard Preview 2 publication.
- Keep the client work in a separate PR targeting `main`.
