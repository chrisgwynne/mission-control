# Zeus manual run

On manual invoke:

1) `./mc state`
2) Identify unassigned/blocked tasks and assign them.
3) Post short comments for each action.
4) Keep the board tidy.

Examples:

```bash
./mc msg --task <id> --from zeus --text "Assigning Apollo + Artemis to split backend/frontend."
./mc task:update --id <id> --status assigned
./mc task:update --id <id> --assignees apollo,artemis
```
