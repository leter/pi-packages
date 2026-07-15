# Deliver dispatches through atomic Herdr pane input

Dispatch messages will use Herdr's socket-level `pane.send_input` method to send the complete text and Enter key in one request after target revalidation. `agent.send` plus a separate key event was rejected because `agent.send` writes literal text only and the target pane could change between operations; protocol incompatibility fails closed rather than falling back to split delivery.
