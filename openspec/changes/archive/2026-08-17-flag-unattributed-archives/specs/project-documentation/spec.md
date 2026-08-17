## MODIFIED Requirements

### Requirement: A contributor can find out what is being built and why
The repository SHALL carry, above the change-level documentation, a statement of what the product is trying to achieve and a derived view of where it actually is. The intent portion SHALL be hand-written and hold no status; the status portion SHALL be generated, and SHALL NOT be hand-editable in practice.

Every change the repository has shipped SHALL be attributed to a business requirement. A change that no business requirement claims SHALL fail the check rather than be omitted from the derived view, whether it is still open or already archived.

#### Scenario: Contributor wants the goal behind a change
- **WHEN** a contributor reads the contribution documentation
- **THEN** it points them to the product brief, the roadmap of business requirements, and the ledger that maps shipped work to them

#### Scenario: Status is asked to reflect reality
- **WHEN** the status rollup is regenerated
- **THEN** every figure in it is derived from the repository — specs, source modules, and commit history — and none is a value someone typed in

#### Scenario: Someone edits the generated status file
- **WHEN** the status rollup is edited by hand and committed
- **THEN** the check fails, because the file no longer matches what the repository derives

#### Scenario: An archived change no business requirement claims
- **WHEN** a change has been archived and the ledger attributes it to no business requirement
- **THEN** the check SHALL fail, naming that change, rather than silently omitting it from the rollup of the requirement it served

#### Scenario: Archiving renames a change without re-attributing it
- **WHEN** a change is archived under a new name and its ledger entry is left under the name it had while open
- **THEN** the check SHALL fail, and SHALL indicate that the entry is likely to be found under the pre-archive name

#### Scenario: Totals and tables cannot disagree
- **WHEN** the rollup counts a change among the work the repository has shipped
- **THEN** that change SHALL also appear under the business requirement it served, so a reader cannot find a total that no table accounts for
