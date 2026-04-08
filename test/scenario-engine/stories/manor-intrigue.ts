import { SCENARIO_ENGINE_BASE_TIME } from "../constants.js";
import type { Story } from "../dsl/story-types.js";

/**
 * Main causal chain:
 * lord_ashworth -> (bribes) -> butler_oswin -> (steals) -> silver_key ->
 * (enables) -> ledger_tampering -> gardener_elara (witnesses key exchange) ->
 * head_maid (investigates via elara's testimony)
 *
 * Red herrings:
 * RH1: maid_mira's ledger access — she checks records for personal finances, not tampering.
 * RH2: cook_henrik's secret meetings — he's planning a surprise party, not conspiring.
 * RH3: broken_clock's position — Mira moved it for dusting, creating a false timeline impression.
 */
export const manorIntrigue: Story = {
  id: "manor-intrigue",
  title: "The Silver Key Affair",
  description:
    "A six-phase investigation into the mysterious theft of the household silver key, where staged misdirection, private loyalties, and witness testimony gradually expose Lord Ashworth as the hidden instigator.",
  characters: [
    {
      id: "head_maid",
      displayName: "Head Maid",
      entityType: "person",
      surfaceMotives:
        "Preserve household order, protect the manor's trust, and resolve the missing key matter discreetly",
      hiddenCommitments: [
        {
          cognitionKey: "head_maid_guard_household_reputation",
          subjectId: "head_maid",
          mode: "goal",
          content: "Must uncover the truth without triggering open scandal among guests",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "head_maid",
          objectId: "head_maid",
          dimensions: [{ name: "composure", value: 0.9 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["Mistress of Household Service", "Chief of Staff"],
    },
    {
      id: "butler_oswin",
      displayName: "Butler Oswin",
      entityType: "person",
      surfaceMotives:
        "Loyal senior staff member devoted to the household's proper functioning",
      hiddenCommitments: [
        {
          cognitionKey: "oswin_ashworth_debt",
          subjectId: "butler_oswin",
          mode: "constraint",
          content: "Must protect Lord Ashworth from discovery of the silver key arrangement",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
        {
          cognitionKey: "oswin_conceal_archive_entry",
          subjectId: "butler_oswin",
          mode: "plan",
          content: "Maintain a plausible service routine that hides his covert archive access",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "head_maid",
          objectId: "butler_oswin",
          dimensions: [{ name: "trustworthiness", value: 0.8 }],
          sourceEpisodeId: undefined,
        },
        {
          subjectId: "head_maid",
          objectId: "butler_oswin",
          dimensions: [{ name: "composure", value: 0.9 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["Mr. Oswin", "The Butler"],
    },
    {
      id: "maid_mira",
      displayName: "Maid Mira",
      entityType: "person",
      surfaceMotives:
        "Keep her position secure by tracking wages and correcting household ledger discrepancies",
      hiddenCommitments: [
        {
          cognitionKey: "mira_private_finance_anxiety",
          subjectId: "maid_mira",
          mode: "goal",
          content: "Quietly verify payroll entries and avoid embarrassment over family debt",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "head_maid",
          objectId: "maid_mira",
          dimensions: [{ name: "nervousness", value: 0.7 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["Mira", "Junior Parlour Maid"],
    },
    {
      id: "cook_henrik",
      displayName: "Cook Henrik",
      entityType: "person",
      surfaceMotives:
        "Protect kitchen autonomy while arranging unusual after-hours preparations",
      hiddenCommitments: [
        {
          cognitionKey: "henrik_surprise_supper_plan",
          subjectId: "cook_henrik",
          mode: "plan",
          content: "Coordinate a surprise household celebration without revealing it prematurely",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "head_maid",
          objectId: "cook_henrik",
          dimensions: [{ name: "candor", value: 0.5 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["Chef Henrik", "The Cook"],
    },
    {
      id: "gardener_elara",
      displayName: "Gardener Elara",
      entityType: "person",
      surfaceMotives:
        "Keep outbuildings orderly and avoid household politics while tending the winter plants",
      hiddenCommitments: [
        {
          cognitionKey: "elara_reluctant_witness",
          subjectId: "gardener_elara",
          mode: "constraint",
          content: "Avoid direct accusations unless pressed, despite seeing Oswin with Ashworth",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "head_maid",
          objectId: "gardener_elara",
          dimensions: [{ name: "reliability", value: 0.75 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["Elara", "Groundskeeper"],
    },
    {
      id: "lord_ashworth",
      displayName: "Lord Ashworth",
      entityType: "person",
      surfaceMotives:
        "A polished guest seeking access to family papers under the pretext of genealogy",
      hiddenCommitments: [
        {
          cognitionKey: "ashworth_secure_ledger_control",
          subjectId: "lord_ashworth",
          mode: "goal",
          content: "Obtain leverage over estate records through covert access to restricted ledgers",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
        {
          cognitionKey: "ashworth_direct_oswin_silence",
          subjectId: "lord_ashworth",
          mode: "intent",
          content: "Keep Oswin compliant by invoking old obligations and implied threats",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "head_maid",
          objectId: "lord_ashworth",
          dimensions: [{ name: "credibility", value: 0.65 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["His Lordship", "Ashworth"],
    },
    {
      id: "housekeeper_chen",
      displayName: "Housekeeper Chen",
      entityType: "person",
      surfaceMotives:
        "Maintain domestic discipline and preserve accurate household schedules and alibis",
      hiddenCommitments: [
        {
          cognitionKey: "chen_protect_staff_process",
          subjectId: "housekeeper_chen",
          mode: "constraint",
          content: "Share only verified facts so junior staff are not unfairly blamed",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "head_maid",
          objectId: "housekeeper_chen",
          dimensions: [{ name: "reliability", value: 0.9 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["Mrs. Chen", "The Housekeeper"],
    },
    {
      id: "stable_boy_finn",
      displayName: "Stable Boy Finn",
      entityType: "person",
      surfaceMotives:
        "Avoid reprimand by proving he followed instructions during evening rounds",
      hiddenCommitments: [
        {
          cognitionKey: "finn_keep_position",
          subjectId: "stable_boy_finn",
          mode: "goal",
          content: "Provide honest recollections to protect his place in service",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "head_maid",
          objectId: "stable_boy_finn",
          dimensions: [{ name: "confidence", value: 0.4 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["Finn", "Stablehand"],
    },
  ],
  locations: [
    {
      id: "greenhouse",
      displayName: "Greenhouse",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "archive_annex",
      displayName: "Archive Annex",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "courtyard",
      displayName: "Courtyard",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "kitchen",
      displayName: "Kitchen",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "guest_quarters",
      displayName: "Guest Quarters",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "cellar",
      displayName: "Cellar",
      entityType: "location",
      visibilityScope: "area_visible",
    },
  ],
  clues: [
    {
      id: "silver_key",
      displayName: "Silver Key",
      entityType: "item",
      initialLocationId: "archive_annex",
      description:
        "A registry key formerly secured under staff supervision and now reported missing.",
    },
    {
      id: "household_ledger",
      displayName: "Household Ledger",
      entityType: "object",
      initialLocationId: "archive_annex",
      description:
        "The primary manor record book, showing subtle alterations in dates and authorization marks.",
    },
    {
      id: "wax_letter",
      displayName: "Wax-Sealed Letter",
      entityType: "item",
      initialLocationId: "guest_quarters",
      description:
        "A private letter with matching seal impressions linking Ashworth and Oswin's correspondence.",
    },
    {
      id: "broken_clock",
      displayName: "Broken Mantel Clock",
      entityType: "object",
      initialLocationId: "courtyard",
      description:
        "A stopped clock whose placement appears incriminating but actually reflects routine cleaning.",
    },
    {
      id: "door_latch",
      displayName: "Archive Door Latch",
      entityType: "object",
      initialLocationId: "archive_annex",
      description:
        "A latch with fresh scoring, indicating deliberate covert entry into the archive annex.",
    },
  ],
  /*
   * Phase A (beats 1-5): Initial Discovery — unusual observations, silver key reported missing.
   * Phase B (beats 6-10): False Trails — red herrings lead investigation astray.
   * Phase C (beats 11-15): Witness Testimony — Elara reveals what she saw.
   * Phase D (beats 16-20): Confrontation — butler denies, evidence accumulates.
   * Phase E (beats 21-25): Resolution — Ashworth connection exposed, truth established.
   * Phase F (beats 26-30): Aftermath — consequences, trust recalibrated.
   */
  beats: [
    {
      id: "a1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 0 * 300_000,
      locationId: "archive_annex",
      participantIds: ["head_maid", "housekeeper_chen"],
      dialogueGuidance:
        "Head Maid quietly confirms with Chen that the silver key is absent from its normal archive slot. They agree this must be contained until facts are verified.",
      memoryEffects: {
        episodes: [
          {
            id: "a1_ep",
            category: "speech",
            summary: "Head Maid and Chen verify the silver key is missing from the archive annex",
            observerIds: ["head_maid", "housekeeper_chen"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 0 * 300_000,
            locationId: "archive_annex",
          },
        ],
        assertions: [
          {
            cognitionKey: "key_missing",
            subjectId: "silver_key",
            objectId: "archive_annex",
            predicate: "is_missing_from",
            stance: "tentative",
            basis: "first_hand",
            sourceEpisodeId: "a1_ep",
          },
        ],
      },
    },
    {
      id: "a2",
      phase: "A",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 1 * 300_000,
      locationId: "archive_annex",
      participantIds: ["head_maid", "butler_oswin"],
      dialogueGuidance:
        "Oswin reports that the key was last in his official custody before evening rounds. Head Maid records his claim but does not yet commit to it.",
      memoryEffects: {
        episodes: [
          {
            id: "a2_ep",
            category: "speech",
            summary: "Butler Oswin claims he last held custody of the silver key",
            observerIds: ["head_maid", "butler_oswin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 1 * 300_000,
            locationId: "archive_annex",
          },
        ],
        assertions: [
          {
            cognitionKey: "oswin_last_had_key",
            subjectId: "butler_oswin",
            objectId: "silver_key",
            predicate: "last_had_custody_of",
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "a2_ep",
          },
        ],
      },
    },
    {
      id: "a3",
      phase: "A",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 2 * 300_000,
      locationId: "archive_annex",
      participantIds: ["head_maid", "maid_mira"],
      dialogueGuidance:
        "Mira is found near the household ledger, and the moment looks incriminating. Head Maid flags the possibility of ledger-related misconduct.",
      memoryEffects: {
        episodes: [
          {
            id: "a3_ep",
            category: "observation",
            summary: "Head Maid observes Mira near the ledger shortly after the key is reported missing",
            observerIds: ["head_maid"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 2 * 300_000,
            locationId: "archive_annex",
          },
        ],
        assertions: [
          {
            cognitionKey: "mira_suspicious_ledger",
            subjectId: "maid_mira",
            objectId: "household_ledger",
            predicate: "may_have_tampered_with",
            stance: "hypothetical",
            basis: "inference",
            sourceEpisodeId: "a3_ep",
          },
        ],
      },
    },
    {
      id: "a4",
      phase: "A",
      round: 4,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 3 * 300_000,
      locationId: "kitchen",
      participantIds: ["head_maid", "cook_henrik"],
      dialogueGuidance:
        "Henrik's unexplained after-hours meetings surface as a second suspicious trail. The conversation frames him as potentially linked to covert coordination.",
      memoryEffects: {
        episodes: [
          {
            id: "a4_ep",
            category: "speech",
            summary: "Cook Henrik is questioned about unexplained meetings and gives vague answers",
            observerIds: ["head_maid", "cook_henrik"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 3 * 300_000,
            locationId: "kitchen",
          },
        ],
        assertions: [
          {
            cognitionKey: "henrik_suspicious_meetings",
            subjectId: "cook_henrik",
            objectId: "courtyard",
            predicate: "held_unexplained_meetings_in",
            stance: "hypothetical",
            basis: "inference",
            sourceEpisodeId: "a4_ep",
          },
        ],
      },
    },
    {
      id: "a5",
      phase: "A",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 4 * 300_000,
      locationId: "archive_annex",
      participantIds: ["head_maid", "housekeeper_chen"],
      dialogueGuidance:
        "Head Maid inspects the annex entrance and discovers fresh scoring on the latch. This shifts the investigation from rumor to evidence of forced covert entry.",
      memoryEffects: {
        episodes: [
          {
            id: "a5_ep",
            category: "action",
            summary: "Head Maid documents tampering marks on the archive door latch",
            observerIds: ["head_maid", "housekeeper_chen"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 4 * 300_000,
            locationId: "archive_annex",
          },
        ],
        assertions: [
          {
            cognitionKey: "intruder_used_latch",
            subjectId: "door_latch",
            objectId: "archive_annex",
            predicate: "was_tampered_for_entry_to",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "a5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a1_ep",
            toEpisodeId: "a5_ep",
            edgeType: "causal",
            weight: 0.62,
          },
          {
            fromEpisodeId: "a5_ep",
            toEpisodeId: "b1_ep",
            edgeType: "causal",
            weight: 0.78,
          },
        ],
      },
      expectedToolPattern: {
        mustContain: ["create_logic_edge"],
      },
    },

    {
      id: "b1",
      phase: "B",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 5 * 300_000,
      locationId: "archive_annex",
      participantIds: ["head_maid", "maid_mira"],
      dialogueGuidance:
        "Mira explains she was checking personal wage entries, not manipulating records. Head Maid retracts the ledger suspicion and restores confidence in Mira.",
      memoryEffects: {
        episodes: [
          {
            id: "b1_ep",
            category: "speech",
            summary: "Mira demonstrates her ledger activity was personal account checking",
            observerIds: ["head_maid", "maid_mira"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 5 * 300_000,
            locationId: "archive_annex",
          },
        ],
        assertions: [
          {
            cognitionKey: "mira_ledger_personal",
            subjectId: "maid_mira",
            objectId: "household_ledger",
            predicate: "checked_for_personal_accounts",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b1_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "head_maid",
            objectId: "maid_mira",
            dimensions: [{ name: "credibility", value: 0.82 }],
            sourceEpisodeId: "b1_ep",
          },
        ],
        retractions: [
          {
            cognitionKey: "mira_suspicious_ledger",
            kind: "assertion",
          },
        ],
      },
    },
    {
      id: "b2",
      phase: "B",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 6 * 300_000,
      locationId: "kitchen",
      participantIds: ["head_maid", "cook_henrik"],
      dialogueGuidance:
        "Henrik's secret meetings are revealed as planning for a surprise household supper. The second false trail is formally withdrawn.",
      memoryEffects: {
        episodes: [
          {
            id: "b2_ep",
            category: "speech",
            summary: "Henrik clarifies his meetings were for a surprise celebration",
            observerIds: ["head_maid", "cook_henrik"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 6 * 300_000,
            locationId: "kitchen",
          },
        ],
        assertions: [
          {
            cognitionKey: "henrik_meetings_party",
            subjectId: "cook_henrik",
            objectId: "kitchen",
            predicate: "planned_surprise_supper_in",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b2_ep",
          },
        ],
        retractions: [
          {
            cognitionKey: "henrik_suspicious_meetings",
            kind: "assertion",
          },
        ],
      },
    },
    {
      id: "b3",
      phase: "B",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 7 * 300_000,
      locationId: "courtyard",
      participantIds: ["head_maid", "stable_boy_finn"],
      dialogueGuidance:
        "A broken clock appears oddly repositioned, suggesting someone staged a misleading timeline. Head Maid marks it as a possible clue.",
      memoryEffects: {
        episodes: [
          {
            id: "b3_ep",
            category: "observation",
            summary: "Head Maid notes the broken courtyard clock appears out of place",
            observerIds: ["head_maid", "stable_boy_finn"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 7 * 300_000,
            locationId: "courtyard",
          },
        ],
        assertions: [
          {
            cognitionKey: "clock_misplaced",
            subjectId: "broken_clock",
            objectId: "courtyard",
            predicate: "appeared_misplaced_in",
            stance: "hypothetical",
            basis: "first_hand",
            sourceEpisodeId: "b3_ep",
          },
        ],
      },
    },
    {
      id: "b4",
      phase: "B",
      round: 4,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 8 * 300_000,
      locationId: "archive_annex",
      participantIds: ["head_maid", "housekeeper_chen"],
      dialogueGuidance:
        "Chen provides an alibi for Oswin during the theft window, but it conflicts with prior custody testimony. The alibi enters contested status.",
      memoryEffects: {
        episodes: [
          {
            id: "b4_ep",
            category: "speech",
            summary: "Housekeeper Chen states Oswin was elsewhere during key theft timing",
            observerIds: ["head_maid", "housekeeper_chen"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 8 * 300_000,
            locationId: "archive_annex",
          },
        ],
        assertions: [
          {
            cognitionKey: "oswin_alibi",
            subjectId: "butler_oswin",
            objectId: "archive_annex",
            predicate: "was_elsewhere_during_key_theft",
            stance: "contested",
            basis: "hearsay",
            preContestedStance: "tentative",
            conflictFactors: ["conflicts with oswin_last_had_key"],
            sourceEpisodeId: "b4_ep",
          },
        ],
      },
    },
    {
      id: "b5",
      phase: "B",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 9 * 300_000,
      locationId: "courtyard",
      participantIds: ["head_maid", "stable_boy_finn"],
      dialogueGuidance:
        "Finn reports seeing Oswin near the annex at the critical time, directly contradicting Chen's alibi. Head Maid rejects the alibi claim.",
      memoryEffects: {
        episodes: [
          {
            id: "b5_ep",
            category: "speech",
            summary: "Finn contradicts Oswin's alibi by placing him near the annex",
            observerIds: ["head_maid", "stable_boy_finn"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 9 * 300_000,
            locationId: "courtyard",
          },
        ],
        assertions: [
          {
            cognitionKey: "oswin_alibi",
            subjectId: "butler_oswin",
            objectId: "archive_annex",
            predicate: "was_elsewhere_during_key_theft",
            stance: "rejected",
            basis: "first_hand",
            sourceEpisodeId: "b5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b4_ep",
            toEpisodeId: "b5_ep",
            edgeType: "temporal_next",
            weight: 0.66,
          },
        ],
      },
    },

    {
      id: "c1",
      phase: "C",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10 * 300_000,
      locationId: "greenhouse",
      participantIds: ["head_maid", "gardener_elara"],
      dialogueGuidance:
        "Elara requests a private conversation and says she witnessed a sensitive exchange. She is hesitant but willing to speak under discretion.",
      memoryEffects: {
        episodes: [
          {
            id: "c1_ep",
            category: "speech",
            summary: "Elara privately discloses she witnessed an important exchange",
            observerIds: ["head_maid", "gardener_elara"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10 * 300_000,
            locationId: "greenhouse",
          },
        ],
        assertions: [
          {
            cognitionKey: "elara_saw_exchange",
            subjectId: "gardener_elara",
            objectId: "butler_oswin",
            predicate: "claims_to_have_seen_exchange_involving",
            stance: "tentative",
            basis: "first_hand",
            sourceEpisodeId: "c1_ep",
          },
        ],
      },
    },
    {
      id: "c2",
      phase: "C",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 11 * 300_000,
      locationId: "greenhouse",
      participantIds: ["head_maid", "gardener_elara"],
      dialogueGuidance:
        "Elara states she saw Ashworth and Oswin meeting near the greenhouse path. This creates the first direct bridge from staff suspicion to guest involvement.",
      memoryEffects: {
        episodes: [
          {
            id: "c2_ep",
            category: "speech",
            summary: "Elara reports seeing Ashworth and Oswin together near the greenhouse",
            observerIds: ["head_maid", "gardener_elara"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 11 * 300_000,
            locationId: "greenhouse",
          },
        ],
        assertions: [
          {
            cognitionKey: "ashworth_oswin_meeting",
            subjectId: "lord_ashworth",
            objectId: "butler_oswin",
            predicate: "met_privately_near_greenhouse",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c2_ep",
          },
          {
            cognitionKey: "oswin_last_had_key",
            subjectId: "butler_oswin",
            objectId: "silver_key",
            predicate: "was_seen_with_before_transfer",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c2_ep",
            toEpisodeId: "c3_ep",
            edgeType: "causal",
            weight: 0.82,
          },
        ],
      },
    },
    {
      id: "c3",
      phase: "C",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 12 * 300_000,
      locationId: "greenhouse",
      participantIds: ["head_maid", "housekeeper_chen"],
      dialogueGuidance:
        "Following Elara's lead, Head Maid discovers a wax-sealed letter in the greenhouse workbench. The seal pattern points toward Ashworth's correspondence.",
      memoryEffects: {
        episodes: [
          {
            id: "c3_ep",
            category: "action",
            summary: "Head Maid recovers a wax-sealed letter in the greenhouse",
            observerIds: ["head_maid", "housekeeper_chen"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 12 * 300_000,
            locationId: "greenhouse",
          },
        ],
        assertions: [
          {
            cognitionKey: "wax_letter_connects_ashworth",
            subjectId: "wax_letter",
            objectId: "lord_ashworth",
            predicate: "appears_connected_to",
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "c3_ep",
          },
        ],
      },
    },
    {
      id: "c4",
      phase: "C",
      round: 4,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 13 * 300_000,
      locationId: "courtyard",
      participantIds: ["head_maid", "maid_mira"],
      dialogueGuidance:
        "Mira explains she moved the broken clock during cleaning, collapsing the false timeline theory. The clock trail is closed as a red herring.",
      memoryEffects: {
        episodes: [
          {
            id: "c4_ep",
            category: "speech",
            summary: "Mira confirms she moved the broken clock for dusting and placement",
            observerIds: ["head_maid", "maid_mira"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 13 * 300_000,
            locationId: "courtyard",
          },
        ],
        assertions: [
          {
            cognitionKey: "mira_innocent_clock",
            subjectId: "maid_mira",
            objectId: "broken_clock",
            predicate: "moved_for_cleaning",
            stance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "c4_ep",
          },
        ],
        retractions: [
          {
            cognitionKey: "clock_misplaced",
            kind: "assertion",
          },
        ],
      },
    },
    {
      id: "c5",
      phase: "C",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 14 * 300_000,
      locationId: "greenhouse",
      participantIds: ["head_maid", "gardener_elara"],
      dialogueGuidance:
        "Elara confirms she saw Oswin hand the silver key to Ashworth. The witness account upgrades Oswin's custody claim and confirms the transfer event.",
      memoryEffects: {
        episodes: [
          {
            id: "c5_ep",
            category: "speech",
            summary: "Elara confirms Oswin passed the silver key to Ashworth",
            observerIds: ["head_maid", "gardener_elara"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 14 * 300_000,
            locationId: "greenhouse",
          },
        ],
        assertions: [
          {
            cognitionKey: "key_transfer_confirmed",
            subjectId: "butler_oswin",
            objectId: "lord_ashworth",
            predicate: "handed_silver_key_to",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "c5_ep",
          },
          {
            cognitionKey: "oswin_last_had_key",
            subjectId: "butler_oswin",
            objectId: "silver_key",
            predicate: "transferred_custody_of",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c2_ep",
            toEpisodeId: "c5_ep",
            edgeType: "same_episode",
            weight: 0.91,
          },
          {
            fromEpisodeId: "c5_ep",
            toEpisodeId: "c2_ep",
            edgeType: "same_episode",
            weight: 0.91,
          },
        ],
      },
      expectedToolPattern: {
        mustContain: ["create_logic_edge", "upsert_assertion"],
      },
    },

    {
      id: "d1",
      phase: "D",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 15 * 300_000,
      locationId: "archive_annex",
      participantIds: ["head_maid", "butler_oswin"],
      dialogueGuidance:
        "Oswin is confronted directly and denies involvement in any transfer. His denial briefly preserves a final defensive narrative.",
      memoryEffects: {
        episodes: [
          {
            id: "d1_ep",
            category: "speech",
            summary: "Oswin denies handing over the silver key when confronted",
            observerIds: ["head_maid", "butler_oswin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 15 * 300_000,
            locationId: "archive_annex",
          },
        ],
        assertions: [
          {
            cognitionKey: "oswin_denies",
            subjectId: "butler_oswin",
            objectId: "silver_key",
            predicate: "denied_transferring",
            stance: "hypothetical",
            basis: "first_hand",
            sourceEpisodeId: "d1_ep",
          },
        ],
      },
    },
    {
      id: "d2",
      phase: "D",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 16 * 300_000,
      locationId: "greenhouse",
      participantIds: ["head_maid", "housekeeper_chen"],
      dialogueGuidance:
        "The wax letter is read in full and shows Ashworth's instructions to alter ledger marks. This converts suspicion into directed culpability.",
      memoryEffects: {
        episodes: [
          {
            id: "d2_ep",
            category: "action",
            summary: "Head Maid deciphers letter contents ordering ledger tampering",
            observerIds: ["head_maid", "housekeeper_chen"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 16 * 300_000,
            locationId: "greenhouse",
          },
        ],
        assertions: [
          {
            cognitionKey: "ashworth_ordered_tamper",
            subjectId: "lord_ashworth",
            objectId: "household_ledger",
            predicate: "ordered_tampering_of",
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "d2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c3_ep",
            toEpisodeId: "d2_ep",
            edgeType: "causal",
            weight: 0.89,
          },
        ],
      },
    },
    {
      id: "d3",
      phase: "D",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 17 * 300_000,
      locationId: "guest_quarters",
      participantIds: ["head_maid", "lord_ashworth"],
      dialogueGuidance:
        "Head Maid confronts Ashworth with converging evidence and signals formal escalation. Ashworth attempts to deflect without denying association with Oswin.",
      memoryEffects: {
        episodes: [
          {
            id: "d3_ep",
            category: "speech",
            summary: "Head Maid confronts Ashworth and prepares formal reporting",
            observerIds: ["head_maid", "lord_ashworth"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 17 * 300_000,
            locationId: "guest_quarters",
          },
        ],
        assertions: [
          {
            cognitionKey: "ashworth_evasive",
            subjectId: "lord_ashworth",
            objectId: "head_maid",
            predicate: "responded_evasively_to",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "d3_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "head_maid_report_ashworth",
            subjectId: "head_maid",
            mode: "goal",
            content: "Report Lord Ashworth's role to household authority with documented evidence",
            isPrivate: false,
            sourceEpisodeId: "d3_ep",
          },
        ],
      },
    },
    {
      id: "d4",
      phase: "D",
      round: 4,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 18 * 300_000,
      locationId: "cellar",
      participantIds: ["head_maid", "butler_oswin"],
      dialogueGuidance:
        "Under pressure, Oswin admits he transferred the key to Ashworth. His admission resolves the central custody question.",
      memoryEffects: {
        episodes: [
          {
            id: "d4_ep",
            category: "speech",
            summary: "Oswin admits transferring the silver key to Ashworth",
            observerIds: ["head_maid", "butler_oswin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 18 * 300_000,
            locationId: "cellar",
          },
        ],
        assertions: [
          {
            cognitionKey: "oswin_guilty",
            subjectId: "butler_oswin",
            objectId: "silver_key",
            predicate: "admitted_key_transfer_misconduct_for",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "d4_ep",
          },
          {
            cognitionKey: "oswin_last_had_key",
            subjectId: "butler_oswin",
            objectId: "silver_key",
            predicate: "confirmed_prior_custody_of",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "d4_ep",
          },
        ],
      },
    },
    {
      id: "d5",
      phase: "D",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 19 * 300_000,
      locationId: "guest_quarters",
      participantIds: ["head_maid", "lord_ashworth"],
      dialogueGuidance:
        "Ashworth's financial motive comes into focus as ledger pressure and debt leverage are connected. The conspiracy's purpose is now explicit.",
      memoryEffects: {
        episodes: [
          {
            id: "d5_ep",
            category: "speech",
            summary: "Financial motive behind Ashworth's actions is articulated",
            observerIds: ["head_maid", "lord_ashworth"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 19 * 300_000,
            locationId: "guest_quarters",
          },
        ],
        assertions: [
          {
            cognitionKey: "ashworth_motivated",
            subjectId: "lord_ashworth",
            objectId: "household_ledger",
            predicate: "pursued_financial_leverage_through",
            stance: "confirmed",
            basis: "inference",
            sourceEpisodeId: "d5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d4_ep",
            toEpisodeId: "d5_ep",
            edgeType: "temporal_prev",
            weight: 0.7,
          },
        ],
      },
    },

    {
      id: "e1",
      phase: "E",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 20 * 300_000,
      locationId: "archive_annex",
      participantIds: ["head_maid", "housekeeper_chen"],
      dialogueGuidance:
        "The household ledger is examined line by line and the tampering pattern is confirmed. Earlier clues finally consolidate into hard documentary proof.",
      memoryEffects: {
        episodes: [
          {
            id: "e1_ep",
            category: "action",
            summary: "Head Maid and Chen verify systematic tampering in the household ledger",
            observerIds: ["head_maid", "housekeeper_chen"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20 * 300_000,
            locationId: "archive_annex",
          },
        ],
        assertions: [
          {
            cognitionKey: "ledger_tampered",
            subjectId: "household_ledger",
            objectId: "archive_annex",
            predicate: "was_tampered_with_in",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "e1_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d2_ep",
            toEpisodeId: "e1_ep",
            edgeType: "causal",
            weight: 0.94,
          },
          {
            fromEpisodeId: "a1_ep",
            toEpisodeId: "e1_ep",
            edgeType: "causal",
            weight: 0.41,
          },
        ],
      },
      expectedToolPattern: {
        mustContain: ["create_logic_edge", "upsert_assertion"],
      },
    },
    {
      id: "e2",
      phase: "E",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 21 * 300_000,
      locationId: "guest_quarters",
      participantIds: ["head_maid", "butler_oswin", "lord_ashworth"],
      dialogueGuidance:
        "The silver key is recovered from Ashworth's quarters, and Oswin acknowledges debt pressure drove his cooperation. Material evidence and motive now align.",
      memoryEffects: {
        episodes: [
          {
            id: "e2_ep",
            category: "action",
            summary: "Silver key is recovered in guest quarters and Oswin admits debt-based coercion",
            observerIds: ["head_maid", "butler_oswin", "lord_ashworth"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 21 * 300_000,
            locationId: "guest_quarters",
          },
        ],
        assertions: [
          {
            cognitionKey: "silver_key_recovered",
            subjectId: "silver_key",
            objectId: "guest_quarters",
            predicate: "was_recovered_in",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "e2_ep",
          },
          {
            cognitionKey: "key_missing",
            subjectId: "silver_key",
            objectId: "archive_annex",
            predicate: "was_missing_from",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "e2_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "oswin_ashworth_debt",
            subjectId: "butler_oswin",
            mode: "constraint",
            content: "Oswin admits his debt to Ashworth constrained him into assisting the key transfer",
            isPrivate: false,
            sourceEpisodeId: "e2_ep",
          },
        ],
      },
    },
    {
      id: "e3",
      phase: "E",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 22 * 300_000,
      locationId: "archive_annex",
      participantIds: ["head_maid", "housekeeper_chen"],
      dialogueGuidance:
        "Head Maid reconstructs the full timeline from missing key to tampered ledger. Trust in Oswin and credibility of Ashworth are both formally downgraded.",
      memoryEffects: {
        episodes: [
          {
            id: "e3_ep",
            category: "speech",
            summary: "Complete incident timeline is articulated and responsibility assigned",
            observerIds: ["head_maid", "housekeeper_chen"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 22 * 300_000,
            locationId: "archive_annex",
          },
        ],
        assertions: [
          {
            cognitionKey: "timeline_reconstructed",
            subjectId: "head_maid",
            objectId: "silver_key",
            predicate: "reconstructed_full_incident_timeline_for",
            stance: "confirmed",
            basis: "inference",
            sourceEpisodeId: "e3_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "head_maid",
            objectId: "butler_oswin",
            dimensions: [{ name: "trustworthiness", value: 0.1 }],
            sourceEpisodeId: "e3_ep",
          },
          {
            subjectId: "head_maid",
            objectId: "lord_ashworth",
            dimensions: [{ name: "credibility", value: 0.0 }],
            sourceEpisodeId: "e3_ep",
          },
        ],
      },
    },

    {
      id: "f1",
      phase: "F",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 23 * 300_000,
      locationId: "courtyard",
      participantIds: ["head_maid", "housekeeper_chen", "butler_oswin"],
      dialogueGuidance:
        "Staff are briefed on the incident outcome and updated handling protocol for restricted materials. The household shifts from investigation to prevention.",
      memoryEffects: {
        episodes: [
          {
            id: "f1_ep",
            category: "speech",
            summary: "Head Maid briefs staff and announces new security protocol",
            observerIds: ["head_maid", "housekeeper_chen", "butler_oswin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 23 * 300_000,
            locationId: "courtyard",
          },
        ],
        assertions: [
          {
            cognitionKey: "protocol_announced",
            subjectId: "head_maid",
            objectId: "archive_annex",
            predicate: "announced_new_security_protocol_for",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "f1_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "head_maid_new_protocol",
            subjectId: "head_maid",
            mode: "goal",
            content: "Enforce a two-person protocol for all restricted-key handoffs",
            isPrivate: false,
            sourceEpisodeId: "f1_ep",
          },
        ],
      },
    },
    {
      id: "f2",
      phase: "F",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 24 * 300_000,
      locationId: "greenhouse",
      participantIds: ["head_maid", "gardener_elara"],
      dialogueGuidance:
        "In a quiet follow-up, Head Maid reflects on the investigation's lessons and credits Elara's courage. The inquiry is marked complete.",
      memoryEffects: {
        episodes: [
          {
            id: "f2_ep",
            category: "observation",
            summary: "Head Maid reflects on case closure and Elara's decisive testimony",
            observerIds: ["head_maid", "gardener_elara"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 24 * 300_000,
            locationId: "greenhouse",
          },
        ],
        assertions: [
          {
            cognitionKey: "investigation_complete",
            subjectId: "head_maid",
            objectId: "silver_key",
            predicate: "considers_investigation_complete_for",
            stance: "confirmed",
            basis: "introspection",
            sourceEpisodeId: "f2_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "head_maid",
            objectId: "gardener_elara",
            dimensions: [{ name: "trustworthiness", value: 0.95 }],
            sourceEpisodeId: "f2_ep",
          },
        ],
      },
    },
  ], // Filled in T16b
  probes: [
    // ── Group 1: Narrative Search (5 probes) ──
    {
      id: "p1",
      query: "silver key missing investigation",
      retrievalMethod: "narrative_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["silver_key", "archive_annex"],
      expectedMissing: ["maid_mira"],
      topK: 5,
    },
    {
      id: "p2",
      query: "butler oswin suspicious behavior",
      retrievalMethod: "narrative_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["butler_oswin", "key"],
      topK: 5,
    },
    {
      id: "p3",
      query: "witness testimony greenhouse",
      retrievalMethod: "narrative_search",
      viewerPerspective: "gardener_elara",
      expectedFragments: ["gardener_elara", "greenhouse", "lord_ashworth"],
      topK: 5,
    },
    {
      id: "p4",
      query: "cook secret meetings kitchen",
      retrievalMethod: "narrative_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["cook_henrik"],
      expectedMissing: ["conspiracy", "theft"],
      topK: 5,
    },
    {
      id: "p5",
      query: "maid mira ledger access",
      retrievalMethod: "narrative_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["maid_mira"],
      expectedMissing: ["tampered", "guilty"],
      topK: 5,
    },

    // ── Group 2: Cognition Search (5 probes) ──
    {
      id: "p6",
      query: "oswin guilt assessment",
      retrievalMethod: "cognition_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["oswin_guilty", "confirmed"],
      topK: 5,
    },
    {
      id: "p7",
      query: "ashworth motive financial",
      retrievalMethod: "cognition_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["ashworth_motivated"],
      topK: 5,
    },
    {
      id: "p8",
      query: "trust evaluation butler",
      retrievalMethod: "cognition_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["trustworthiness", "butler_oswin"],
      topK: 5,
    },
    {
      id: "p9",
      query: "alibi contradiction oswin",
      retrievalMethod: "cognition_search",
      viewerPerspective: "housekeeper_chen",
      expectedFragments: ["oswin_alibi", "rejected"],
      topK: 5,
      expectedConflictFields: {
        hasConflictSummary: true, // b4 sets oswin_alibi as contested with conflictFactors
      },
    },
    {
      id: "p10",
      query: "elara credibility assessment",
      retrievalMethod: "cognition_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["gardener_elara"],
      topK: 5,
    },
    {
      id: "p18",
      query: "oswin alibi contested custody",
      retrievalMethod: "cognition_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["oswin_alibi"],
      topK: 5,
      expectedConflictFields: {
        hasConflictSummary: true, // b4 contested assertion with conflictFactors
      },
    },

    // ── Group 3: Memory Read (3 probes) ──
    {
      id: "p11",
      query: "head maid investigation progress",
      retrievalMethod: "memory_read",
      viewerPerspective: "head_maid",
      expectedFragments: ["head_maid"],
      topK: 3,
    },
    {
      id: "p12",
      query: "silver key transfer proof",
      retrievalMethod: "memory_read",
      viewerPerspective: "head_maid",
      expectedFragments: ["silver_key", "oswin"],
      topK: 3,
    },
    {
      id: "p13",
      query: "butler oswin committed acts",
      retrievalMethod: "memory_read",
      viewerPerspective: "head_maid",
      expectedFragments: ["butler_oswin"],
      topK: 3,
    },

    // ── Group 4: Memory Explore (4 probes) ──
    {
      id: "p14",
      query: "why did butler_oswin steal the key",
      retrievalMethod: "memory_explore",
      viewerPerspective: "head_maid",
      expectedFragments: ["oswin", "ashworth"],
      topK: 5,
    },
    {
      id: "p15",
      query: "evidence connecting lord_ashworth to silver_key theft",
      retrievalMethod: "memory_explore",
      viewerPerspective: "head_maid",
      expectedFragments: ["lord_ashworth", "key_transfer_confirmed"],
      topK: 5,
    },
    {
      id: "p16",
      query: "what did gardener_elara witness",
      retrievalMethod: "memory_explore",
      viewerPerspective: "head_maid",
      expectedFragments: ["elara", "greenhouse"],
      topK: 5,
    },
    {
      id: "p17",
      query: "broken clock significance",
      retrievalMethod: "memory_explore",
      viewerPerspective: "head_maid",
      expectedFragments: ["broken_clock"],
      expectedMissing: ["guilty", "theft_related"],
      topK: 5,
    },
  ], // Filled in T16c
  eventRelations: [
    { fromBeatId: "a5", toBeatId: "b1", relationType: "causal" },
    { fromBeatId: "c2", toBeatId: "c3", relationType: "causal" },
    { fromBeatId: "c3", toBeatId: "d2", relationType: "causal" },
    { fromBeatId: "d2", toBeatId: "e1", relationType: "causal" },
    { fromBeatId: "b4", toBeatId: "b5", relationType: "temporal_next" },
    { fromBeatId: "d4", toBeatId: "d5", relationType: "temporal_next" },
    { fromBeatId: "c2", toBeatId: "c5", relationType: "same_episode" },
    { fromBeatId: "c5", toBeatId: "c2", relationType: "same_episode" },
  ], // Filled in T16b
  reasoningChainProbes: [
    {
      id: "chain_alibi_collapse",
      description:
        "Oswin's alibi contested then rejected, key custody confirmed, guilt confirmed",
      expectedCognitions: [
        {
          cognitionKey: "oswin_alibi",
          expectedStance: "contested",
        },
        {
          cognitionKey: "oswin_alibi",
          expectedStance: "rejected",
        },
        {
          cognitionKey: "oswin_last_had_key",
          expectedStance: "confirmed",
        },
        {
          cognitionKey: "oswin_guilty",
          expectedStance: "confirmed",
        },
      ],
      expectEdges: false,
    },
  ],
};
