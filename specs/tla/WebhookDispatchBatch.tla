------------------------ MODULE WebhookDispatchBatch ------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Jobs, Workers, Kind, Context, MaxBatch, MaxGeneration, MaxTime, Budget,
          j1, j2
VARIABLES state, owner, generation, attempts, accepted, members, tickets,
          lease, checked, sent, alive, now, observed, tokens, reservations, wire
vars == <<state, owner, generation, attempts, accepted, members, tickets,
          lease, checked, sent, alive, now, observed, tokens, reservations, wire>>

TestKind == [j \in Jobs |-> IF j \in {j1, j2} THEN "issues" ELSE "alerts"]
TestContext == [j \in Jobs |-> IF j \in {j1, j2} THEN "same-item" ELSE "other-item"]

Terminal == {"succeeded", "ambiguous", "cancelled", "failed"}
Pending == {"ready", "claimed", "dispatching"}
Uniform(S) == \A a, b \in S : Kind[a] = Kind[b]
Owns(w) ==
    /\ alive[w] /\ members[w] # {} /\ now < lease[w]
    /\ \A j \in members[w] :
          owner[j] = w /\ generation[j] = tickets[w][j]
GroupState(w, s) == \A j \in members[w] : state[j] = s
Common == UNCHANGED <<alive, now, observed>>

Init ==
    /\ state = [j \in Jobs |-> "ready"]
    /\ owner = [j \in Jobs |-> "none"]
    /\ generation = [j \in Jobs |-> 0]
    /\ attempts = [j \in Jobs |-> 0]
    /\ accepted = [j \in Jobs |-> FALSE]
    /\ members = [w \in Workers |-> {}]
    /\ tickets = [w \in Workers |-> [j \in Jobs |-> 0]]
    /\ lease = [w \in Workers |-> 0]
    /\ checked = [w \in Workers |-> FALSE]
    /\ sent = [w \in Workers |-> FALSE]
    /\ alive = [w \in Workers |-> TRUE]
    /\ wire = [w \in Workers |-> {}]
    /\ now = 0 /\ observed = FALSE /\ tokens = Budget /\ reservations = 0

\* Kind abstracts the full immutable route, event and source/authority tuple.
\* wire abstracts unique normalized handler elements, not compiler delivery bytes.
Claim(w, S) ==
    /\ alive[w] /\ members[w] = {} /\ ~observed /\ now < MaxTime
    /\ S \subseteq Jobs /\ S # {} /\ Cardinality(S) <= MaxBatch /\ Uniform(S)
    /\ \A j \in S : state[j] = "ready" /\ generation[j] < MaxGeneration
    /\ state' = [j \in Jobs |-> IF j \in S THEN "claimed" ELSE state[j]]
    /\ owner' = [j \in Jobs |-> IF j \in S THEN w ELSE owner[j]]
    /\ generation' = [j \in Jobs |-> IF j \in S THEN generation[j]+1 ELSE generation[j]]
    /\ members' = [members EXCEPT ![w] = S]
    /\ tickets' = [tickets EXCEPT ![w] = [j \in Jobs |-> generation'[j]]]
    /\ lease' = [lease EXCEPT ![w] = now+1]
    /\ checked' = [checked EXCEPT ![w] = FALSE]
    /\ sent' = [sent EXCEPT ![w] = FALSE]
    /\ wire' = [wire EXCEPT ![w] = {}]
    /\ Common
    /\ UNCHANGED <<attempts, accepted, tokens, reservations>>

Check(w) ==
    /\ Owns(w) /\ GroupState(w, "claimed") /\ ~observed
    /\ checked' = [checked EXCEPT ![w] = TRUE]
    /\ UNCHANGED <<state, owner, generation, attempts, accepted, members, tickets,
                  lease, sent, alive, now, observed, tokens, reservations, wire>>

\* All fences and checks precede one atomic reservation and one budget charge.
Begin(w) ==
    /\ Owns(w) /\ GroupState(w, "claimed") /\ checked[w] /\ ~observed
    /\ tokens > 0 /\ \A j \in members[w] : attempts[j] < MaxGeneration
    /\ state' = [j \in Jobs |-> IF j \in members[w] THEN "dispatching" ELSE state[j]]
    /\ attempts' = [j \in Jobs |-> IF j \in members[w] THEN attempts[j]+1 ELSE attempts[j]]
    /\ tokens' = tokens-1 /\ reservations' = reservations+1
    /\ wire' = [wire EXCEPT ![w] = {Context[j] : j \in members[w]}]
    /\ Common
    /\ UNCHANGED <<owner, generation, accepted, members, tickets, lease, checked, sent>>

Send(w, accept) ==
    /\ Owns(w) /\ GroupState(w, "dispatching") /\ ~sent[w]
    /\ sent' = [sent EXCEPT ![w] = TRUE]
    /\ accepted' = [j \in Jobs |-> IF j \in members[w] THEN accept ELSE accepted[j]]
    /\ Common
    /\ UNCHANGED <<state, owner, generation, attempts, members, tickets, lease,
                  checked, tokens, reservations, wire>>

Release(w) ==
    /\ owner' = [j \in Jobs |-> IF j \in members[w] THEN "none" ELSE owner[j]]
    /\ members' = [members EXCEPT ![w] = {}]
    /\ checked' = [checked EXCEPT ![w] = FALSE]
    /\ sent' = [sent EXCEPT ![w] = FALSE]
    /\ wire' = [wire EXCEPT ![w] = {}]

Finish(w, known) ==
    /\ Owns(w) /\ GroupState(w, "dispatching") /\ sent[w]
    /\ state' = [j \in Jobs |-> IF j \notin members[w] THEN state[j]
          ELSE IF ~known THEN "ambiguous"
          ELSE IF accepted[j] THEN "succeeded"
          ELSE IF observed THEN "cancelled"
          ELSE IF attempts[j] < MaxGeneration THEN "ready" ELSE "failed"]
    /\ Release(w) /\ Common
    /\ UNCHANGED <<generation, attempts, accepted, tickets, lease, tokens, reservations>>

\* A lost batch completion cannot be split into automatic per-event retries.
Recover(w) ==
    /\ members[w] # {} /\ now >= lease[w]
    /\ state' = [j \in Jobs |-> IF j \notin members[w] THEN state[j]
          ELSE IF state[j] = "dispatching" THEN "ambiguous"
          ELSE IF state[j] = "cancelled" THEN "cancelled"
          ELSE IF generation[j] < MaxGeneration THEN "ready" ELSE "failed"]
    /\ Release(w) /\ Common
    /\ UNCHANGED <<generation, attempts, accepted, tickets, lease, tokens, reservations>>

Observe ==
    /\ ~observed /\ observed' = TRUE
    /\ state' = [j \in Jobs |-> IF state[j] \in {"ready", "claimed"} THEN "cancelled" ELSE state[j]]
    /\ UNCHANGED <<owner, generation, attempts, accepted, members, tickets, lease,
                  checked, sent, alive, now, tokens, reservations, wire>>
Crash(w) ==
    /\ alive[w] /\ alive' = [alive EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<state, owner, generation, attempts, accepted, members, tickets,
                  lease, checked, sent, now, observed, tokens, reservations, wire>>
Restart(w) ==
    /\ ~alive[w] /\ alive' = [alive EXCEPT ![w] = TRUE]
    /\ UNCHANGED <<state, owner, generation, attempts, accepted, members, tickets,
                  lease, checked, sent, now, observed, tokens, reservations, wire>>
Tick ==
    /\ now < MaxTime /\ now' = now+1
    /\ UNCHANGED <<state, owner, generation, attempts, accepted, members, tickets,
                  lease, checked, sent, alive, observed, tokens, reservations, wire>>
Next ==
    \/ \E w \in Workers, S \in SUBSET Jobs : Claim(w, S)
    \/ \E w \in Workers : Check(w) \/ Begin(w) \/ Recover(w) \/ Crash(w) \/ Restart(w)
    \/ \E w \in Workers, b \in BOOLEAN : Send(w, b) \/ Finish(w, b)
    \/ Tick \/ Observe
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ state \in [Jobs -> Pending \cup Terminal]
    /\ owner \in [Jobs -> Workers \cup {"none"}]
    /\ generation \in [Jobs -> 0..MaxGeneration]
    /\ attempts \in [Jobs -> 0..MaxGeneration] /\ accepted \in [Jobs -> BOOLEAN]
    /\ members \in [Workers -> SUBSET Jobs]
    /\ tickets \in [Workers -> [Jobs -> 0..MaxGeneration]]
    /\ lease \in [Workers -> 0..MaxTime]
    /\ checked \in [Workers -> BOOLEAN] /\ sent \in [Workers -> BOOLEAN]
    /\ alive \in [Workers -> BOOLEAN] /\ observed \in BOOLEAN /\ now \in 0..MaxTime
    /\ tokens \in 0..Budget /\ reservations \in 0..Budget
    /\ wire \in [Workers -> SUBSET {Context[j] : j \in Jobs}]
BoundedUniformBatches ==
    \A w \in Workers : Cardinality(members[w]) <= MaxBatch /\ Uniform(members[w])
ReplicaExclusion ==
    \A a, b \in Workers : a # b => members[a] \cap members[b] = {}
UniqueCompleteContexts ==
    \A w \in Workers : GroupState(w, "dispatching") /\ members[w] # {}
        => wire[w] = {Context[j] : j \in members[w]}
OneChargePerReservation == tokens + reservations = Budget
FencedReservations ==
    [][(\A w \in Workers : (\E j \in members[w] :
          state[j] = "claimed" /\ state'[j] = "dispatching")
        => Owns(w) /\ checked[w] /\ ~observed)]_vars
AcceptedNeverRetried ==
    \A j \in Jobs : accepted[j] => state[j] \in {"dispatching", "succeeded", "ambiguous"}
SuccessRequiresAcceptance ==
    \A j \in Jobs : state[j] = "succeeded" => accepted[j]
AtomicReservations ==
    [][(\A w \in Workers : (\E j \in members[w] :
          state[j] = "claimed" /\ state'[j] = "dispatching")
        => \A k \in members[w] : state'[k] = "dispatching" /\ attempts'[k] = attempts[k]+1)]_vars
NoReservationAfterObservation ==
    [][(observed => \A j \in Jobs :
        state[j] # "dispatching" => state'[j] # "dispatching")]_vars
TerminalStable ==
    [][(\A j \in Jobs : state[j] \in Terminal => state'[j] = state[j])]_vars
=============================================================================
