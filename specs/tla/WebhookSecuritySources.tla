----------------------- MODULE WebhookSecuritySources -----------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Sources, Destination, MaxVersion, MaxTime, FreshWindow
Repositories == Sources \cup {Destination}
VARIABLES now, selected, enrolled, private, valid, checked, state, jobRevision,
          revision, accepted
vars == <<now, selected, enrolled, private, valid, checked, state, jobRevision,
          revision, accepted>>

\* Selectors abstract exact/wildcard matching; they never mutate enrollment.
Init ==
    /\ now = 0 /\ revision = 1
    /\ selected \in SUBSET Sources
    /\ enrolled \in SUBSET Repositories /\ private \in SUBSET Repositories
    /\ valid = Repositories /\ checked = [r \in Repositories |-> 0]
    /\ state = [s \in Sources |-> "absent"]
    /\ jobRevision = [s \in Sources |-> 0]
    /\ accepted = {}

Fresh(r) == r \in valid /\ now < checked[r] + FreshWindow
Authorized(s) ==
    /\ s \in selected /\ {s, Destination} \subseteq enrolled \cap private
    /\ Fresh(s) /\ Fresh(Destination)
Admit(s) ==
    /\ Authorized(s) /\ state[s] = "absent"
    /\ state' = [state EXCEPT ![s] = "ready"]
    /\ jobRevision' = [jobRevision EXCEPT ![s] = revision]
    /\ UNCHANGED <<now, selected, enrolled, private, valid, checked, revision, accepted>>
Reserve(s) ==
    /\ Authorized(s) /\ state[s] = "ready" /\ jobRevision[s] = revision
    /\ state' = [state EXCEPT ![s] = "dispatching"]
    /\ UNCHANGED <<now, selected, enrolled, private, valid, checked, jobRevision, revision, accepted>>
Accept(s) ==
    /\ state[s] = "dispatching"
    /\ state' = [state EXCEPT ![s] = "succeeded"] /\ accepted' = accepted \cup {s}
    /\ UNCHANGED <<now, selected, enrolled, private, valid, checked, jobRevision, revision>>
\* A source or workflow hint shares the existing globally fenced queue epoch.
Hint(r) ==
    /\ revision < MaxVersion /\ revision' = revision + 1
    /\ valid' = valid \ {r}
    /\ state' = [s \in Sources |-> IF state[s] = "ready" THEN "cancelled" ELSE state[s]]
    /\ UNCHANGED <<now, selected, enrolled, private, checked, jobRevision, accepted>>
Refresh(r) ==
    /\ r \in enrolled \cap private
    /\ valid' = valid \cup {r} /\ checked' = [checked EXCEPT ![r] = now]
    /\ UNCHANGED <<now, selected, enrolled, private, state, jobRevision, revision, accepted>>
Tick ==
    /\ now < MaxTime /\ now' = now + 1
    /\ UNCHANGED <<selected, enrolled, private, valid, checked, state, jobRevision, revision, accepted>>
Next ==
    \/ \E s \in Sources : Admit(s) \/ Reserve(s) \/ Accept(s)
    \/ \E r \in Repositories : Hint(r) \/ Refresh(r)
    \/ Tick
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ now \in 0..MaxTime /\ revision \in 1..MaxVersion
    /\ selected \subseteq Sources /\ enrolled \subseteq Repositories
    /\ private \subseteq Repositories /\ valid \subseteq Repositories
    /\ checked \in [Repositories -> 0..MaxTime]
    /\ state \in [Sources -> {"absent", "ready", "dispatching", "cancelled", "succeeded"}]
    /\ jobRevision \in [Sources -> 0..MaxVersion] /\ accepted \subseteq Sources
NoUnenrolledDispatch ==
    \A s \in Sources : state[s] \in {"ready", "dispatching", "succeeded"} =>
        s \in selected /\ {s, Destination} \subseteq enrolled \cap private
NoStaleReady == \A s \in Sources : state[s] = "ready" => jobRevision[s] = revision
AcceptedNeverRetried == \A s \in accepted : state[s] = "succeeded"
FreshSourceAndDestinationReservation ==
    [][(\A s \in Sources : state[s] # "dispatching" /\ state'[s] = "dispatching" =>
        Authorized(s) /\ jobRevision[s] = revision)]_vars
SelectorsNeverGrantAuthority == [][(UNCHANGED <<enrolled, private>>)]_vars
=============================================================================
