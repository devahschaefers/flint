import { faker } from '@faker-js/faker'
import type { Account, Category, Contact, Folder, Mailbox, Message } from './types'

/**
 * Seeded mock mailbox built on real email primitives: RFC 5322 headers,
 * Message-ID / In-Reply-To / References chains, IMAP-style flags and folders.
 * Threads are never stored — they fall out of the reference chains at runtime.
 */

faker.seed(1337)

export const accounts: Account[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    identity: { name: 'Devah Schaefers', address: 'devah.schaefers@gmail.com' },
    color: '#EA4335'
  },
  {
    id: 'college',
    name: 'College',
    identity: { name: 'Devah Schaefers', address: 'dschaefers@college.edu' },
    color: '#00897B'
  },
  {
    id: 'berkeley',
    name: 'Berkeley',
    identity: { name: 'Devah Schaefers', address: 'devah@berkeley.edu' },
    color: '#7B1FA2'
  },
  {
    id: 'icloud',
    name: 'iCloud',
    identity: { name: 'Devah Schaefers', address: 'devah@icloud.com' },
    color: '#5C6BC0'
  },
  {
    id: 'abundant',
    name: 'Abundant',
    identity: { name: 'Devah Schaefers', address: 'devah@abundant.io' },
    color: '#C2185B'
  }
]

function identityOf(accountId: string): Mailbox {
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]
  return account.identity
}

// ---------------------------------------------------------------------------
// The recurring cast. Contacts are the address book (contact name wins over the
// header display name — Mom's mail arrives as "Linda Schaefers" but shows as
// "Mom"). Institutional senders are deliberately NOT contacts: their names ride
// on each message's From header, like real mailing lists.
// ---------------------------------------------------------------------------

export const seedContacts: Contact[] = [
  { address: 'linda.schaefers@comcast.net', name: 'Mom', source: 'seed' },
  { address: 'gary.schaefers@comcast.net', name: 'Dad', source: 'seed' },
  { address: 'carol.hutchins@gmail.com', name: 'Aunt Carol', source: 'seed' },
  { address: 'priya.raghavan@kcl.ac.uk', name: 'Priya Raghavan', source: 'seed' },
  { address: 'jan.armstrong@berkeley.edu', name: 'Jan Armstrong', source: 'seed' },
  { address: 'dortha.koss@berkeley.edu', name: 'Dortha Koss', source: 'seed' },
  { address: 'ranade@eecs.berkeley.edu', name: 'Prof. Ranade', source: 'seed' },
  { address: 'mokhtari@stat.berkeley.edu', name: 'Prof. Elena Mokhtari', source: 'seed' },
  { address: 'sarahkim.cal@gmail.com', name: 'Sarah Kim', source: 'seed' },
  { address: 'jordan.reyes@berkeley.edu', name: 'Jordan Reyes', source: 'seed' },
  { address: 'alex.wang@berkeley.edu', name: 'Alex Wang', source: 'seed' },
  { address: 'tessa.liang@gmail.com', name: 'Tessa Liang', source: 'seed' },
  { address: 'noah.petersen@gmail.com', name: 'Noah Petersen', source: 'seed' },
  { address: 'elena.marsh@gmail.com', name: 'Elena Marsh', source: 'seed' },
  { address: 'hana.suzuki@berkeley.edu', name: 'Hana Suzuki', source: 'seed' },
  { address: 'owen.blackwell@berkeley.edu', name: 'Owen Blackwell', source: 'seed' },
  { address: 'marcus.bell@berkeley.edu', name: 'Marcus Bell', source: 'seed' },
  { address: 'maya.flores@berkeley.edu', name: 'Maya Flores', source: 'seed' },
  { address: 'leo.tran@berkeley.edu', name: 'Leo Tran', source: 'seed' },
  { address: 'amara.diallo@berkeley.edu', name: 'Amara Diallo', source: 'seed' },
  { address: 'felix.nguyen@gmail.com', name: 'Felix Nguyen', source: 'seed' },
  { address: 'ines.castillo@berkeley.edu', name: 'Ines Castillo', source: 'seed' },
  { address: 'tom.okafor@berkeley.edu', name: 'Tom Okafor', source: 'seed' },
  { address: 'ruth.landau@berkeley.edu', name: 'Ruth Landau', source: 'seed' },
  { address: 'peter.quist@abundant.io', name: 'Peter Quist', source: 'seed' }
]

// Mom's header name differs from her contact name on purpose (contact wins).
const MOM: Mailbox = { name: 'Linda Schaefers', address: 'linda.schaefers@comcast.net' }
const PRIYA: Mailbox = { name: 'Priya Raghavan', address: 'priya.raghavan@kcl.ac.uk' }
const JAN: Mailbox = { name: 'Jan Armstrong', address: 'jan.armstrong@berkeley.edu' }
const DORTHA: Mailbox = { name: 'Dortha Koss', address: 'dortha.koss@berkeley.edu' }
const RANADE: Mailbox = { name: 'Gita Ranade', address: 'ranade@eecs.berkeley.edu' }
const SARAH: Mailbox = { name: 'Sarah Kim', address: 'sarahkim.cal@gmail.com' }
// Jordan writes from a client that sends no display name; the contact resolves it.
const JORDAN: Mailbox = { address: 'jordan.reyes@berkeley.edu' }
const ALEX: Mailbox = { name: 'Alex Wang', address: 'alex.wang@berkeley.edu' }
const TESSA: Mailbox = { name: 'Tessa Liang', address: 'tessa.liang@gmail.com' }
const NOAH: Mailbox = { name: 'Noah Petersen', address: 'noah.petersen@gmail.com' }
const ELENA: Mailbox = { name: 'Elena Marsh', address: 'elena.marsh@gmail.com' }
const HANA: Mailbox = { name: 'Hana Suzuki', address: 'hana.suzuki@berkeley.edu' }
const OWEN: Mailbox = { name: 'Owen Blackwell', address: 'owen.blackwell@berkeley.edu' }
const FELIX: Mailbox = { name: 'Felix Nguyen', address: 'felix.nguyen@gmail.com' }

/**
 * Senders for the generated people stream. Includes contacts (some sending
 * without a display name), named non-contacts (header name renders), and 2-3
 * bare non-contacts that must render as raw addresses, Gmail-style.
 */
const PEOPLE_POOL: Mailbox[] = [
  JAN,
  DORTHA,
  SARAH,
  JORDAN,
  ALEX,
  { name: 'Maya Flores', address: 'maya.flores@berkeley.edu' },
  { name: 'Leo Tran', address: 'leo.tran@berkeley.edu' },
  { name: 'Amara Diallo', address: 'amara.diallo@berkeley.edu' },
  FELIX,
  { name: 'Ines Castillo', address: 'ines.castillo@berkeley.edu' },
  { name: 'Tom Okafor', address: 'tom.okafor@berkeley.edu' },
  { name: 'Ruth Landau', address: 'ruth.landau@berkeley.edu' },
  { name: 'Marcus Bell', address: 'marcus.bell@berkeley.edu' },
  HANA,
  OWEN,
  NOAH,
  TESSA,
  ELENA,
  { name: 'Peter Quist', address: 'peter.quist@abundant.io' },
  { name: 'Becca Ellison', address: 'becca.ellison@gmail.com' }, // named, no contact
  { name: 'Theo Lindqvist', address: 'theo.lindqvist@gmail.com' }, // named, no contact
  { address: 'mkoslowski@ocf.berkeley.edu' }, // bare address, no contact
  { address: 'd.hutch04@gmail.com' }, // bare address, no contact
  { address: 'zoe.trann@yahoo.com' } // bare address, no contact
]

const NAMED_POOL: Mailbox[] = PEOPLE_POOL.filter((p) => p.name !== undefined)

// ---------------------------------------------------------------------------
// Message construction. Every seeded message gets a unique Message-ID under
// the sender's own domain; reply chains are built with a helper that mirrors
// the store's sendReply semantics (references grow, parents get \Answered).
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const NOW = Date.now()

let seedSeq = 0
function seedId(fromAddress: string): string {
  seedSeq += 1
  return `<seed-${seedSeq}@${fromAddress.split('@')[1]}>`
}

const built: Message[] = []

interface MessageInput {
  from: Mailbox
  to: Mailbox[]
  cc?: Mailbox[]
  replyTo?: Mailbox
  subject: string
  /** epoch ms */
  date: number
  body: string[]
  accountId: string
  folder?: Folder
  seen?: boolean
  flagged?: boolean
  answered?: boolean
  inReplyTo?: string
  references?: string[]
  category?: Category
}

function push(input: MessageInput): Message {
  const message: Message = {
    messageId: seedId(input.from.address),
    inReplyTo: input.inReplyTo,
    references: input.references ?? [],
    from: input.from,
    to: input.to,
    cc: input.cc ?? [],
    replyTo: input.replyTo,
    subject: input.subject,
    date: new Date(input.date).toISOString(),
    body: input.body,
    accountId: input.accountId,
    folder: input.folder ?? 'inbox',
    flags: {
      seen: input.seen ?? true,
      flagged: input.flagged ?? false,
      answered: input.answered ?? false
    },
    category: input.category ?? 'people',
    important: false
  }
  built.push(message)
  return message
}

interface ReplyInput {
  date: number
  body: string[]
  accountId: string
  folder: Folder
  seen?: boolean
  to?: Mailbox[]
  cc?: Mailbox[]
}

/** Append a reply to `parent`: chains references; our replies mark the parent \Answered. */
function makeReply(parent: Message, from: Mailbox, input: ReplyInput): Message {
  const isOwn = accounts.some((a) => a.identity.address === from.address)
  if (isOwn) parent.flags.answered = true
  return push({
    from,
    to: input.to ?? (isOwn ? [parent.replyTo ?? parent.from] : [identityOf(input.accountId)]),
    cc: input.cc,
    subject: /^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`,
    date: input.date,
    body: input.body,
    accountId: input.accountId,
    folder: input.folder,
    seen: input.seen,
    inReplyTo: parent.messageId,
    references: [...parent.references, parent.messageId],
    category: parent.category
  })
}

// ---------------------------------------------------------------------------
// Hand-written conversations: real multi-message threads with proper
// In-Reply-To/References chains, sent replies from the account identities, and
// \Answered on the messages Devah replied to.
// ---------------------------------------------------------------------------

// Study group: incoming → our reply → fresh unread follow-up referencing both.
const studyM1 = push({
  from: JAN,
  to: [identityOf('berkeley')],
  subject: 'study group this weekend',
  date: NOW - 1.1 * DAY,
  body: [
    'A few of us want to grind through HW3 before the midterm — are you free Saturday afternoon? I can book a Moffitt room if people commit today.',
    "Bring whatever you have for part (c). Nobody I've talked to has it working, which is either comforting or very bad news.",
    'Jan'
  ],
  accountId: 'berkeley'
})
const studyM2 = makeReply(studyM1, identityOf('berkeley'), {
  date: NOW - 0.6 * DAY,
  folder: 'sent',
  accountId: 'berkeley',
  body: [
    "Saturday at 2 works — see you on the Moffitt 4th floor. I'll bring my HW3 attempt: parts (a) and (b) are done, plus a graveyard of failed ideas for (c).",
    "Can we also spend 20 minutes on the exchange argument before we start? I think I finally get the tie-breaking case, and explaining it out loud will tell me whether that's actually true.",
    'Devah'
  ]
})
makeReply(studyM2, JAN, {
  date: NOW - 0.15 * DAY,
  folder: 'inbox',
  accountId: 'berkeley',
  seen: false,
  body: [
    "Room's booked — Moffitt 405, under my name, 2 to 5. Six of us so far.",
    'Also the GSI just posted a hint on Q4(c) that basically hands you the invariant. Reading it now; I will summarize for the group so nobody has to admit how long we all stared at it.',
    'Jan'
  ]
})

// Mom: contact name "Mom" beats her "Linda Schaefers" header name. Flagged thread.
const momM1 = push({
  from: MOM,
  to: [identityOf('gmail')],
  subject: 'checking in',
  date: NOW - 1.6 * DAY,
  flagged: true,
  body: [
    "Hi sweetheart, Dad and I were talking about your London plans last night. Have you heard back about housing yet? Grandma wants to know if you'll be home for Thanksgiving before you go.",
    'Also your cousin Emma got into Michigan, so expect a call from Aunt Carol about it. Act surprised.',
    'Eat something green this week. Love, Mom'
  ],
  accountId: 'gmail'
})
const momM2 = makeReply(momM1, identityOf('gmail'), {
  date: NOW - 1.2 * DAY,
  folder: 'sent',
  accountId: 'gmail',
  body: [
    "Hi Mom, good news — housing came through this morning. I got a spot at Stamford Street, the one eight minutes from campus. It's an ensuite, so you can officially stop worrying about the shared bathroom thing.",
    "Yes to Thanksgiving — I land the Tuesday before. And I'll call Grandma this Sunday, I promise. Tell her to take her phone off silent this time.",
    'Love, Devah'
  ]
})
makeReply(momM2, MOM, {
  date: NOW - 0.45 * DAY,
  folder: 'inbox',
  accountId: 'gmail',
  seen: false,
  body: [
    'Stamford Street! Wonderful, sweetheart. Dad already found it on the map and measured the walk to campus, because of course he did. Eight minutes, he confirms.',
    "Grandma has been told to expect your call Sunday and has already told her book club. No pressure. Love, Mom"
  ]
})

// Discussion notes trade with Dortha.
const notesM1 = push({
  from: DORTHA,
  to: [identityOf('berkeley')],
  subject: "Notes from today's discussion",
  date: NOW - 2.5 * DAY,
  body: [
    'Hey Devah, here are my notes from discussion today. I flagged the part about exchange arguments since the GSI hinted it shows up on the midterm.',
    "The worked example on slide 14 is the one he called 'exam-adjacent', so I typed that one up in full. My handwriting on the proof sketch got bad toward the end — ping me if a step doesn't make sense.",
    "Doc is in our shared folder under 'disc-week4'."
  ],
  accountId: 'berkeley'
})
const notesM2 = makeReply(notesM1, identityOf('berkeley'), {
  date: NOW - 2.1 * DAY,
  folder: 'sent',
  accountId: 'berkeley',
  body: [
    'You are genuinely a lifesaver — the slide 14 writeup is clearer than the actual lecture. I added my solutions for the practice problems at the bottom of the doc in a different color.',
    'Trade accepted on the CDSS notes. And no, I have not started the project either. Nine days is basically two weeks if you round up.',
    'Devah'
  ]
})
makeReply(notesM2, DORTHA, {
  date: NOW - 1.9 * DAY,
  folder: 'inbox',
  accountId: 'berkeley',
  body: [
    'Saw your solutions — your Q2 is cleaner than mine, I am stealing the notation. CDSS notes are in the same folder now; the sampling diagrams actually came out legible this time.',
    "Project status unchanged for both of us, I see. Nine days. It's fine. Everything is fine."
  ]
})

// Intro thread: Tessa intros Priya (cc), we reply to Priya, Priya answers twice.
// Latest counterpart is Priya, so the row reads "Priya Raghavan 4". Flagged.
const introM1 = push({
  from: TESSA,
  to: [identityOf('berkeley')],
  cc: [PRIYA],
  subject: 'intro to my friend at KCL',
  date: NOW - 7.0 * DAY,
  flagged: true,
  body: [
    "Devah — meet Priya, she's a second-year at King's and lived in Stamford Street last year. Priya, Devah's headed to KCL in the spring and has housing questions.",
    "Priya did the whole Zone 1 versus Zone 2 math last year so you don't have to, and she knows which modules are secretly great. She's also just fun — you two will get along.",
    "I'll let you two take it from here!"
  ],
  accountId: 'berkeley'
})
const introM2 = makeReply(introM1, identityOf('berkeley'), {
  date: NOW - 6.5 * DAY,
  folder: 'sent',
  accountId: 'berkeley',
  to: [PRIYA],
  cc: [TESSA],
  body: [
    "Hi Priya, so nice to e-meet you! I just got placed at Stamford Street, which I hear is where you lived — I am very open to a brain dump on anything from laundry logistics to which modules are secretly great.",
    "No rush at all, but if you're up for a call sometime in the next few weeks I'd love that. Whatever time works with the time difference — my schedule is flexible after 9 AM Pacific.",
    'Thanks for being up for the intro. Devah'
  ]
})
const introM3 = makeReply(introM2, PRIYA, {
  date: NOW - 5.8 * DAY,
  folder: 'inbox',
  accountId: 'berkeley',
  body: [
    "Hi Devah! Congratulations on Stamford Street — genuinely the best decision you didn't know you were making. The laundry room is a social scene, the walk to Strand is nothing, and the corner room on floor 6 has the river view if you get any say in it.",
    'Happy to do a call — Thursdays after 6 my time are best. Bring housing and module questions, I have opinions about both.',
    'Priya'
  ]
})
makeReply(introM3, PRIYA, {
  date: NOW - 0.9 * DAY,
  folder: 'inbox',
  accountId: 'berkeley',
  seen: false,
  body: [
    "Also — before I forget, module selection opens next week and the good War Studies seminars fill inside a day. If you want any of them, rank them first, not as reserves.",
    'Still on for Thursday? I have a lecture until 5:30 but am free after.',
    'Priya'
  ]
})

// Flight logistics with Noah.
const flightM1 = push({
  from: NOAH,
  to: [identityOf('gmail')],
  subject: 'flight to Heathrow',
  date: NOW - 4.4 * DAY,
  body: [
    'I found a nonstop SFO-LHR on the 8th for $612 if we book by Friday. If we land together we can split the Heathrow Express, or honestly the Piccadilly line is fine.',
    "The return leg is the annoying part — flying back on a Saturday adds like $150. I say we book the outbound now and sort returns later, since your program end date isn't final anyway.",
    "Sending you the Google Flights link — fare-lock it if you're not ready to commit."
  ],
  accountId: 'gmail'
})
const flightM2 = makeReply(flightM1, identityOf('gmail'), {
  date: NOW - 3.8 * DAY,
  folder: 'sent',
  accountId: 'gmail',
  body: [
    "Booked! Nonstop on the 8th, seat 34A, $612 exactly as promised. Send me your confirmation number and I'll see about getting us seats together — worst case we bribe whoever has 34B.",
    'Agreed on skipping the Heathrow Express; the Piccadilly line goes straight to my halls anyway. First pub lunch is on me if you handle the Oyster card logistics.',
    'Devah'
  ]
})
makeReply(flightM2, NOAH, {
  date: NOW - 3.2 * DAY,
  folder: 'inbox',
  accountId: 'gmail',
  body: [
    'Got 34B — no bribery required, the seat map gods provide. Confirmation is QX4LTR if you want to link the bookings.',
    'I caved and booked the Saturday return anyway; the $150 stung less than a 6 AM Tuesday landing before a Wednesday lecture. You have been warned about my priorities.'
  ]
})

// Recommendation letter: a thread ROOTED at our own sent message.
const recM1 = push({
  from: identityOf('berkeley'),
  to: [RANADE],
  subject: 'Recommendation letter for UCEAP application',
  date: NOW - 3.6 * DAY,
  folder: 'sent',
  accountId: 'berkeley',
  body: [
    "Dear Professor Ranade, I'm applying to UCEAP's spring program at King's College London and the application asks for one academic reference. Would you be willing to write in support? I took your algorithms course last spring and it's a big part of why I'm pursuing the theory-leaning modules at KCL.",
    "The letter would be due October 15 through the UCEAP portal. I'm happy to send along anything that would make it easier — resume, transcript, or a reminder of my coursework.",
    'Thank you for considering it. Devah Schaefers'
  ]
})
const recM2 = makeReply(recM1, RANADE, {
  date: NOW - 3.3 * DAY,
  folder: 'inbox',
  accountId: 'berkeley',
  body: [
    "Hi Devah, I'd be glad to write in support of your application. Could you send me your resume, transcript, and a short paragraph on the program by end of next week?",
    'It also helps if you remind me which assignments from my course you were proudest of — specifics make these letters much stronger than generalities.',
    'And confirm the deadline for me, please. I want to make sure it goes in well ahead of time.'
  ]
})
makeReply(recM2, identityOf('berkeley'), {
  date: NOW - 3.0 * DAY,
  folder: 'sent',
  accountId: 'berkeley',
  body: [
    "Thank you so much — this means a lot. I've attached my resume, unofficial transcript, and a paragraph about the KCL program and why I'm applying.",
    "The assignments I'm proudest of from your course are the scheduling problem on HW2 and my final project on approximation algorithms. Happy to send either writeup if it would help.",
    'The deadline is October 15 through the UCEAP portal — it should email you a submission link directly. Thanks again, Devah'
  ]
})

// Housing shortlist: sent root with one incoming reply.
const housingM1 = push({
  from: identityOf('gmail'),
  to: [ELENA],
  subject: 'housing in London',
  date: NOW - 9.5 * DAY,
  folder: 'sent',
  accountId: 'gmail',
  body: [
    "Halls shortlist, ranked: Stamford Street (eight minutes to campus), Goodenough College (gorgeous, Zone 1, formal dinners??), and a Zone 2 wildcard near the Tube that's £60/week cheaper.",
    "Thoughts? You're better at this than me and you know I will agonize until someone else decides.",
    'Devah'
  ]
})
makeReply(housingM1, ELENA, {
  date: NOW - 8.7 * DAY,
  folder: 'inbox',
  accountId: 'gmail',
  body: [
    'Ok so I looked at the halls you sent — Stamford Street is way closer to campus but Goodenough College looks amazing. My cousin says Zone 2 is fine if you get a room near the Tube.',
    "Also apparently Goodenough has a formal dinner thing, which is either amazing or deeply weird and I genuinely can't tell. Stamford Street is like eight minutes to campus though, and you hate commuting.",
    "Want to just call tonight and go through the options together? I'm free after 8."
  ]
})

// CDSS lab debugging with Owen.
const cdssM1 = push({
  from: OWEN,
  to: [identityOf('berkeley')],
  subject: 'Quick question about the CDSS lab',
  date: NOW - 10.8 * DAY,
  body: [
    "Hey, in lab 4 did your confidence interval come out around (0.42, 0.58)? Mine looks suspicious and I can't tell if I'm bootstrapping wrong or the data is just like that.",
    'I reran it with 10,000 resamples instead of 1,000 and it barely moved, so now I suspect my cleaning step. Did you drop the null rows before or after splitting?'
  ],
  accountId: 'berkeley'
})
makeReply(cdssM1, identityOf('berkeley'), {
  date: NOW - 10.5 * DAY,
  folder: 'sent',
  accountId: 'berkeley',
  body: [
    "Mine came out to (0.44, 0.57), so yours isn't crazy. I dropped the null rows before splitting — the lab spec buries that in a footnote under the second code cell.",
    "If it still looks off after that, check that you're resampling with replacement. That one cost me an hour.",
    'Devah'
  ]
})

// Sublease: three messages ending in good news.
const subleaseM1 = push({
  from: HANA,
  to: [identityOf('icloud')],
  subject: 'Spring sublease?',
  date: NOW - 6.0 * DAY,
  body: [
    "Hey! Heard you're going abroad in the spring — are you planning to sublease your room? My friend is transferring in January and needs a place near campus.",
    "She's clean, quiet, and has a cat (deal-breaker? be honest). She can do $1,100 plus utilities, and the timing lines up with your program almost exactly — January through May.",
    'No pressure either way, just let me know before you list it anywhere else.'
  ],
  accountId: 'icloud'
})
const subleaseM2 = makeReply(subleaseM1, identityOf('icloud'), {
  date: NOW - 5.5 * DAY,
  folder: 'sent',
  accountId: 'icloud',
  body: [
    "Yes — I'm subleasing January through May and your friend's timing is basically perfect. $1,100 plus utilities works, and the cat is fine as long as she covers anything the cat destroys.",
    "I'm putting together a short listing with photos this week. I'll send it to you first so she gets first shot before I post it anywhere.",
    'Devah'
  ]
})
makeReply(subleaseM2, HANA, {
  date: NOW - 4.9 * DAY,
  folder: 'inbox',
  accountId: 'icloud',
  body: [
    "She's in!! And she says the cat, quote, 'destroys nothing but expectations.' I'll forward the listing the second you send it — thank you for holding it for her.",
    'She can do a video call walkthrough whenever, her schedule is flexible until the semester starts.'
  ]
})

// Mock interview planning with Alex (also the GitHub PR requester).
const stripeM1 = push({
  from: ALEX,
  to: [identityOf('berkeley')],
  subject: 'did you see the Stripe posting',
  date: NOW - 8.9 * DAY,
  body: [
    'The Stripe intern posting just went up on Handshake and it closes in two weeks. We should do a mock interview swap before then — are you free Tuesday?',
    "I can do Tuesday after 4 or Wednesday morning. Let's do one behavioral and one medium problem each, and actually time them this round instead of chatting through the answers."
  ],
  accountId: 'berkeley'
})
makeReply(stripeM1, identityOf('berkeley'), {
  date: NOW - 8.4 * DAY,
  folder: 'sent',
  accountId: 'berkeley',
  body: [
    "Tuesday after 4 works. Let's do the full loop: one behavioral, one medium each, actually timed, and no 'wait, let me just finish this thought' at the 35-minute mark. (That one's directed at me, not you.)",
    "I grabbed a Cory breakout room for 4:15. Bring your question list from last time and I'll bring two new ones from the tagged list.",
    'Devah'
  ]
})

// Lost charger — Jordan sends with no display name; the contact still resolves.
const chargerM1 = push({
  from: JORDAN,
  to: [identityOf('berkeley')],
  subject: 'you left your charger in Soda',
  date: NOW - 4.9 * DAY,
  body: [
    "pretty sure this is yours — it was on the table in 380 after we left. I'll be in the Woz until 5 if you want to come grab it.",
    "It's the 96W one with the sticker, so I figured you'd want it back before your laptop dies mid-lecture again."
  ],
  accountId: 'berkeley'
})
makeReply(chargerM1, identityOf('berkeley'), {
  date: NOW - 4.5 * DAY,
  folder: 'sent',
  accountId: 'berkeley',
  body: [
    "That's mine, thank you!! I spent twenty minutes this morning convinced I'd left it at V&A. I'll swing by the Woz around 4:30 — if you've left by then, just leave it with whoever's at the front desk.",
    'I owe you a coffee. Devah'
  ]
})

// Dinner plans — the live refresh rotation grows this thread (see below).
const dinnerM1 = push({
  from: SARAH,
  to: [identityOf('gmail')],
  subject: 'Dinner Friday?',
  date: NOW - 9.6 * DAY,
  body: [
    "We're doing Thai on Telegraph before you disappear to London forever. Friday 7pm, usual spot. Say yes.",
    "Sarah's in, Marcus is a maybe because of his 6pm section. If we get there before 7 we can actually get the big table in the back."
  ],
  accountId: 'gmail'
})
const dinnerM2 = makeReply(dinnerM1, identityOf('gmail'), {
  date: NOW - 9.3 * DAY,
  folder: 'sent',
  accountId: 'gmail',
  body: [
    "Yes, obviously. I'll be there at 7 sharp, I'm getting the drunken noodles, and you cannot stop me.",
    "Also, 'before you disappear to London forever' — it's five months. I'll be back before the good weather. Save the guilt trip for my mom, she's better at it.",
    'Devah'
  ]
})

// ---------------------------------------------------------------------------
// Other hand-written mail: standalone sent, drafts (one a proper reply draft),
// a couple of standalone inbox pieces, and the spam folder.
// ---------------------------------------------------------------------------

const UCEAP: Mailbox = { name: 'Berkeley Study Abroad - UCEAP', address: 'studyabroad@berkeley.edu' }

// Standalone sent mail.
push({
  from: identityOf('berkeley'),
  to: [UCEAP],
  subject: 'Question about my transcript upload',
  date: NOW - 7.2 * DAY,
  folder: 'sent',
  accountId: 'berkeley',
  category: 'notifications',
  body: [
    "Hi, I submitted my Acknowledgement of Nomination last week, but my portal checklist still shows the transcript item as 'in review' after ten days. The confirmation email said reviews take two business days.",
    'Could you confirm it was received? I want to make sure nothing is holding up my file before the KCL deadline. My student ID is 3036841772.',
    'Thank you, Devah Schaefers'
  ]
})
push({
  from: identityOf('icloud'),
  to: [HANA],
  subject: 'sublease listing — read this before I post?',
  date: NOW - 5.2 * DAY,
  folder: 'sent',
  accountId: 'icloud',
  body: [
    "Can you sanity-check this before I put it up? 'Sunny room in 3BR near North Berkeley BART, Jan-May, $1,100/mo + utilities, furnished, quiet housemates, no smoking.' Does 'quiet housemates' sound like a threat?",
    'Also: do I mention the kitchen situation, or let them discover the ant thing organically? Kidding. Mostly.',
    'Devah'
  ]
})

// A UCEAP notice we started answering: the reply lives in drafts with a real
// In-Reply-To chain back to this message.
const checklistMsg = push({
  from: UCEAP,
  to: [identityOf('berkeley')],
  subject: 'Pre-Departure Checklist: 45 days to go',
  date: NOW - 2.0 * DAY,
  accountId: 'berkeley',
  category: 'notifications',
  body: [
    'Dear Devah, Your program start date is approaching. Please review your pre-departure checklist: passport validity, visa appointment, flight itinerary, and proof of insurance are still outstanding.',
    'Your passport must be valid for at least six months beyond your program end date. UK Student visa appointments at the San Francisco application centre are currently booking about three weeks out, so schedule yours now.',
    'Upload each document to the portal as you complete it. Items are reviewed within two business days and you will be notified of anything that needs correction.'
  ]
})
push({
  from: identityOf('berkeley'),
  to: [UCEAP],
  subject: 'Re: Pre-Departure Checklist: 45 days to go',
  date: NOW - 1.5 * DAY,
  folder: 'drafts',
  accountId: 'berkeley',
  category: 'notifications',
  inReplyTo: checklistMsg.messageId,
  references: [checklistMsg.messageId],
  body: [
    "Hi, Quick question about the insurance requirement — I'm currently on SHIP through campus. Does that satisfy the UCEAP coverage minimums for the UK, or do I need the supplemental plan regardless? The checklist wording"
  ]
})

// Remaining drafts.
push({
  from: identityOf('gmail'),
  to: [{ name: 'Mom', address: MOM.address }],
  subject: 'thanksgiving flights',
  date: NOW - 0.3 * DAY,
  folder: 'drafts',
  accountId: 'gmail',
  body: [
    "Hi Mom, Looking at flights home for Thanksgiving — the Tuesday night one gets in at 11:40pm, the Wednesday morning one is $120 more but I'd actually be awake for dinner prep.",
    "Also thinking about what to do with my plants while I'm in London. Options are (a) you inherit them, (b)"
  ]
})
push({
  from: identityOf('berkeley'),
  to: [OWEN],
  subject: 'project partner?',
  date: NOW - 2.4 * DAY,
  folder: 'drafts',
  accountId: 'berkeley',
  body: [
    "Hey — are you doing the CDSS project with anyone yet? I'm dangerously close to just doing it solo, but the spec says groups of two get access to the bigger dataset and",
    '(also fair warning, I will be in London for the last two weeks of it, but the deliverables are all remote-friendly)'
  ]
})
push({
  from: identityOf('gmail'),
  to: [FELIX],
  subject: 'packing list — what did you actually use?',
  date: NOW - 4.1 * DAY,
  folder: 'drafts',
  accountId: 'gmail',
  body: [
    'Making my London packing list and realizing I own three jackets that all do the same thing. You studied abroad — what did you actually use vs. haul around for five months?',
    'Current list: laptop, two universal adapters (learned from your mistake), rain shell, one nice outfit for whatever formal dinner situation may arise, and'
  ]
})

// A standalone note from Mom (header name again resolved to "Mom" by contacts).
push({
  from: MOM,
  to: [identityOf('gmail')],
  subject: 'Fwd: Your flight confirmation',
  date: NOW - 11.2 * DAY,
  accountId: 'gmail',
  body: [
    'Forwarding this so you have a copy too. Dad says to book the airport shuttle early. Also call your grandmother, she asked about you twice this week.',
    'Do you need us to bring anything up when we visit before you leave? Dad found your old rain jacket in the garage and insists London requires it.',
    'Love, Mom'
  ]
})

// Spam. Named senders, no contacts, obviously fake domains.
interface SpamTemplate {
  from: Mailbox
  accountId: string
  subject: string
  body: string[]
  daysAgo: number
  seen: boolean
}

const SPAM_MAIL: SpamTemplate[] = [
  {
    from: { name: 'USPS Parcel Alert', address: 'delivery@usps-parcel-alerts.info' },
    accountId: 'gmail',
    subject: 'Your package could not be delivered — schedule redelivery now',
    daysAgo: 0.8,
    seen: false,
    body: [
      'Dear Customer, We attempted to deliver your package today but were unable to complete the delivery because of an incomplete address. Your parcel USPS-9400-1102-8845 is being held at our facility.',
      'To schedule redelivery, please confirm your address and pay the $1.95 redelivery fee within 24 hours or your package will be returned to sender.',
      'This is the final notice. Click here to confirm your details now.'
    ]
  },
  {
    from: { name: 'Coinbase Rewards', address: 'promo@coinbase-rewardz.win' },
    accountId: 'gmail',
    subject: 'You have unclaimed Bitcoin worth $312.44',
    daysAgo: 2.4,
    seen: false,
    body: [
      'Congratulations! Our records show a pending BTC reward of $312.44 linked to this email address from our 2025 loyalty program. Rewards not claimed within 48 hours are forfeited.',
      'Verify your wallet now to release the funds. This offer cannot be extended.'
    ]
  },
  {
    from: { name: 'Netflix Billing', address: 'account-verify@netfliix-support.com' },
    accountId: 'icloud',
    subject: 'Your account is on hold — update your payment information',
    daysAgo: 4.6,
    seen: true,
    body: [
      'Dear Valued Customer, We were unable to process your last payment. To avoid interruption of service, please update your billing information within 48 hours.',
      'If we do not receive updated payment details, your membership and viewing history will be permanently deleted. Update now to keep watching.'
    ]
  },
  {
    from: { name: 'Vehicle Warranty Dept', address: 'noreply@auto-warranty-final.org' },
    accountId: 'icloud',
    subject: "FINAL NOTICE: your vehicle's extended warranty",
    daysAgo: 7.5,
    seen: false,
    body: [
      "We have been trying to reach you concerning your vehicle's extended warranty. Your factory coverage has expired or is about to expire, and you are still eligible for renewal at a reduced rate.",
      'This is your final courtesy notice before your file is closed permanently. Reply now to speak with a coverage specialist today.'
    ]
  },
  {
    from: { name: 'Prize Notification Dept', address: 'claims@intl-lottery-notice.net' },
    accountId: 'gmail',
    subject: 'CONGRATULATIONS: your email address has WON $2,500,000.00',
    daysAgo: 11,
    seen: true,
    body: [
      'Dear Lucky Winner, Your email address was selected in the International Email Lottery Programme held on 15th August. You have won the sum of $2,500,000.00 (Two Million Five Hundred Thousand Dollars).',
      'To begin your claim, send your full name, address, phone number, and a copy of a valid ID to our claims agent. Note: keep this notification confidential to avoid double claims.'
    ]
  },
  {
    from: { name: 'Barrister Emmanuel Okon', address: 'emmanuel.okon.esq@lagos-chambers-mail.com' },
    accountId: 'berkeley',
    subject: 'URGENT BUSINESS PROPOSAL (CONFIDENTIAL)',
    daysAgo: 13.8,
    seen: false,
    body: [
      'Dear Friend, I am Barrister Emmanuel Okon, personal attorney to a late client who shares your surname. He left behind the sum of USD $8.4M in a dormant account with no next of kin.',
      'I propose to present you as the beneficiary. For your cooperation you will receive 40% of the total sum. This transaction is 100% risk free and legal.',
      'Kindly reply with your direct telephone number for more details. Time is of the essence.'
    ]
  }
]

for (const s of SPAM_MAIL) {
  push({
    from: s.from,
    to: [identityOf(s.accountId)],
    subject: s.subject,
    date: NOW - s.daysAgo * DAY,
    body: s.body,
    accountId: s.accountId,
    folder: 'spam',
    seen: s.seen,
    category: 'notifications'
  })
}

// ---------------------------------------------------------------------------
// The generated stream: institutional notifications, one-off people mail, and
// calendar invites, dense recently and thinning out ~20 days back.
// ---------------------------------------------------------------------------

interface MsgTemplate {
  subject: string
  body: string[]
}

interface NotifSource {
  from: Mailbox
  accountId: string
  replyTo?: Mailbox
  messages: MsgTemplate[]
}

const NOTIF_SOURCES: NotifSource[] = [
  {
    from: UCEAP,
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Overdue Acknowledgement of Nomination Requirement',
        body: [
          'Dear Devah, You have not completed one or more of the Action Items in your UCEAP Portal. The Acknowledgement of Nomination is now overdue and must be submitted before we can release your placement.',
          'To resolve this, log in to your UCEAP Portal and open the Action Items tab. The acknowledgement takes about five minutes and requires your electronic signature at the bottom of the form.',
          'If the item is not completed by September 5, your nomination may be withdrawn and your spot offered to a waitlisted student. If you believe you are receiving this message in error, reply with your student ID and program name.'
        ]
      },
      {
        subject: "UCEAP ACTION REQUIRED - MUST READ - KING'S COLLEGE LONDON",
        body: [
          "Dear Student, Congratulations on your nomination to King's College London for Spring 2027. Before we can proceed, you must review the attached program agreement and confirm your participation.",
          'The agreement covers program dates (12 January - 5 June 2027), tuition and fee arrangements, housing disclaimers, and the UCEAP student conduct policy. Read every section carefully before signing — you are bound by its contents once submitted.',
          "After you confirm, your file is forwarded to King's and you will receive King's Apply login instructions within ten business days. No further action is possible on our side until the agreement is signed."
        ]
      },
      {
        subject: 'Nomination for Study Abroad at KCL - next step',
        body: [
          "Hi Devah, Great news — your nomination has been forwarded to King's College London. The next step is to complete the KCL online application through King's Apply within 14 days.",
          "Have ready: a scanned copy of your passport photo page, your unofficial transcript, and a short statement of purpose (300-500 words). Draft the statement in advance — King's Apply times out after 30 minutes of inactivity.",
          'Questions about any step? Drop-in advising runs Tuesday through Thursday, 1-4 PM in Stephens Hall 160, no appointment needed.'
        ]
      },
      {
        subject: 'Reminder: Study Abroad 101 Webinar this Thursday',
        body: [
          'Join us Thursday at 4:00 PM PT for Study Abroad 101, covering budgeting, housing, and academic planning for your term abroad. Registration closes Wednesday at noon.',
          'This session is strongly recommended for first-time program participants. Returning students from KCL, Edinburgh, and UCL will join for the last 20 minutes to answer questions about daily life abroad.',
          'A recording will be posted afterward, but only live attendees can submit questions to the panel.'
        ]
      }
    ]
  },
  {
    from: { name: 'UC Learning Center', address: 'noreplyuclc@berkeley.edu' },
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Your UC Learning Center transcript',
        body: [
          'This is an automated message from the UC Learning Center. Your training transcript has been updated. Log in to view your completed and assigned activities.',
          'Recently recorded: EHS 101 Introduction to Safety (completed). Currently assigned: 3 activities. Certificates for completed courses can be downloaded from your transcript page.',
          'Do not reply to this message; this mailbox is not monitored.'
        ]
      },
      {
        subject: 'Assigned Training: Cybersecurity Awareness 2026',
        body: [
          'The following training has been assigned to you in the UC Learning Center: Cybersecurity Awareness Fundamentals. Due date: 30 days from assignment. This activity is required for all active students.',
          'The module takes approximately 45 minutes and can be completed across multiple sittings; your progress is saved automatically. A score of 80% or higher on the final quiz is required for credit.',
          'If you believe this training was assigned in error, contact your department training coordinator.'
        ]
      },
      {
        subject: 'Training due soon: 3 items require completion',
        body: [
          'This is a reminder that you have 3 assigned training activities due within the next 14 days. Please log in to the UC Learning Center to complete them before the deadline.',
          'Due soon: Cybersecurity Awareness Fundamentals (Sept 9), EHS 702 Heat Illness Prevention (Sept 14), and FERPA Basics for Student Employees (Sept 21).',
          'Overdue trainings are reported to your department coordinator at the end of each month.'
        ]
      }
    ]
  },
  {
    from: { name: 'Ed', address: 'no-reply@edstem.org' },
    accountId: 'berkeley',
    messages: [
      {
        subject: 'New threads in EECS 101 and CDSS 101',
        body: [
          "You have new activity in your courses. EECS 101: 'Clarification on HW3 Q2 runtime bounds' and 4 more threads. CDSS 101: 'Project 1 rubric posted' and 2 more.",
          "Most active in EECS 101: 'Clarification on HW3 Q2 runtime bounds' — 11 replies and 2 instructor endorsements. You are watching this thread, so new replies will keep appearing here.",
          'You can change how often Ed emails you (instant, daily digest, or never) in your notification settings.'
        ]
      },
      {
        subject: 'Instructor endorsed your answer in EECS 101',
        body: [
          "Your answer to 'Is memoization required for full credit on Q4?' was endorsed by an instructor. View the thread to see follow-up comments from your classmates.",
          "Instructor comment: 'Great explanation — this is exactly the intuition we want. Memoization is not required for full credit, but it makes part (c) much easier to reason about.'",
          'Endorsed answers are pinned to the top of the thread and count toward your participation credit.'
        ]
      },
      {
        subject: 'Reply to your question in CDSS 101',
        body: [
          "Someone replied to your thread 'Confused about the bootstrap sampling step in lab 4'. Click through to view the reply and continue the discussion.",
          "The reply reads: 'I hit the same thing — the trick is to resample with replacement from your own sample, not from the population column. The spec footnote on page 3 is doing a lot of work here.'"
        ]
      },
      {
        subject: 'Weekly digest: 23 new posts in your courses',
        body: [
          "Here's what you missed this week on Ed. EECS 101: 14 new threads and 3 announcements. CDSS 101: 6 new threads, including 'Midterm logistics megathread'.",
          "Most active: 'Midterm logistics megathread' with 41 replies. Announcements this week: HW3 deadline extended to Friday, project partner form closes Sunday, and lab section 104 moved to Evans 10.",
          'View the full digest on Ed to catch up before Monday lecture.'
        ]
      }
    ]
  },
  {
    from: { name: 'KCL - StudyAbroad', address: 'studyabroad@kcl.ac.uk' },
    accountId: 'berkeley',
    messages: [
      {
        subject: "King's Apply: your application has been received",
        body: [
          "Dear Applicant, Thank you for submitting your Study Abroad application to King's College London. Your application ID is 2027-SA-08841. We aim to respond within 15 working days.",
          "Please do not submit a duplicate application, as this can delay processing. You can track your status at any time by logging in to King's Apply.",
          'If you contact us about your application, please quote your application ID in all correspondence.'
        ]
      },
      {
        subject: 'Module selection now open for Study Abroad students',
        body: [
          "Dear Incoming Student, Module selection for the Spring term is now open in King's Apply. Please select four modules and two reserves before the stated deadline.",
          'Study Abroad students may choose modules across departments, subject to prerequisites and timetable fit. Popular options in War Studies and Digital Humanities fill quickly, so rank your reserves carefully.',
          'Selections are treated as preferences rather than guarantees. Departments review requests in November and confirmed timetables are released in early December.'
        ]
      },
      {
        subject: 'Action needed: upload your official transcript',
        body: [
          "Dear Devah, Our records show your application is missing an official transcript. Please upload a PDF copy via King's Apply within 10 working days to avoid delays.",
          'The transcript must show all courses completed to date, your cumulative GPA, and the institution name. Screenshots of a student portal are not accepted.',
          'Once uploaded, documents are verified within five working days and your checklist will update automatically.'
        ]
      }
    ]
  },
  {
    from: { name: 'London Study Center', address: 'info@londonstudycenter.org' },
    accountId: 'berkeley',
    replyTo: { name: 'London Study Center', address: 'hello@londonstudycenter.org' },
    messages: [
      {
        subject: 'Housing options for Spring 2027 now live',
        body: [
          'Hello future Londoner! Our Spring 2027 housing portal is now open. Options include ensuite rooms in Zone 1 student halls from £285/week, with flexible contract lengths for study abroad students.',
          'All rooms include utilities, Wi-Fi, and contents insurance, and contracts can be matched to your exact program dates. Reserve with a £250 deposit, fully refundable up to 60 days before move-in.',
          'A word of advice from past students: rooms near Waterloo and Southwark historically sell out by late October.'
        ]
      },
      {
        subject: 'Your London arrival guide',
        body: [
          'From Heathrow to your halls: everything you need for arrival week, including the Piccadilly line, Oyster cards versus contactless, and where to get a UK SIM on day one.',
          'Budget tip: skip the Heathrow Express. The Piccadilly line runs from every terminal to Zone 1 in about 50 minutes and accepts contactless, no ticket needed.',
          'Our welcome desk is staffed 8 AM - 8 PM throughout arrivals week, and airport meet-and-greet slots can be booked until the Friday before you fly.'
        ]
      }
    ]
  },
  {
    from: { name: 'GitHub', address: 'notifications@github.com' },
    accountId: 'gmail',
    messages: [
      {
        subject: '[GitHub] Your Dependabot alerts digest',
        body: [
          'We found 3 vulnerabilities in devahs/cs164-project. 1 high severity in lodash < 4.17.21 and 2 moderate in webpack-dev-server. Review and dismiss or upgrade.',
          'The high-severity alert is a prototype pollution issue (CVE-2021-23337) in lodash. Upgrading to 4.17.21 or later resolves it; Dependabot can open a pull request with the version bump for you.',
          'The moderate alerts affect webpack-dev-server only in development, but we still recommend upgrading at your convenience.'
        ]
      },
      {
        subject: '[GitHub] Please verify your device',
        body: [
          'Hey devahs! A sign-in attempt requires further verification because we did not recognize your device. Your device verification code is 481-229.',
          'Enter the code within 10 minutes to complete sign-in. If you did not attempt to sign in, we strongly recommend changing your password and reviewing your account security log.'
        ]
      },
      {
        subject: '[devahs/eecs101-hw] CI failed on push to main',
        body: [
          'Run failed: test-suite (ubuntu-latest). 2 of 47 checks failed in 3m 12s. FAIL test/scheduler.test.ts — expected quantum 4 to preempt at tick 12.',
          "Second failure: test/scheduler.test.ts 'starvation guard promotes waiting jobs' — expected a priority boost after 3 quanta, received none. Both failures were introduced in commit a41f2c8.",
          'View the full logs for this run in the Actions tab of devahs/eecs101-hw.'
        ]
      },
      {
        subject: '[cs164-project] alexwang requested your review on #42',
        body: [
          "alexwang requested your review on pull request #42: Refactor parser to handle nested scopes. 'Can you double-check the symbol table changes before I merge?'",
          "From the PR description: 'Scopes are now a chain of tables instead of one flat map, and lookup walks outward until it hits the global scope. The old API is preserved so the interpreter tests pass unchanged.'",
          '9 files changed, +412 -168. CI is green.'
        ]
      }
    ]
  },
  {
    from: { name: 'LinkedIn', address: 'messages-noreply@linkedin.com' },
    accountId: 'gmail',
    replyTo: { name: 'LinkedIn Job Alerts', address: 'jobs-listings@linkedin.com' },
    messages: [
      {
        subject: 'You appeared in 9 searches this week',
        body: [
          "You're getting noticed. You appeared in 9 searches this week, including searchers from Google, Databricks, and a stealth startup. See who's looking.",
          "Common search terms that led to your profile: 'berkeley eecs', 'react typescript intern', and 'student developer'. Members with a summary section appear in up to 3x more searches."
        ]
      },
      {
        subject: "New jobs for 'software engineering intern' in Berkeley",
        body: [
          '24 new jobs match your alert. Software Engineering Intern at Stripe, SWE Intern - Summer 2027 at Nvidia, and 22 more. Apply early to stand out.',
          'Also matching your profile: Backend Intern at Plaid, Product Engineering Intern at Figma, and SWE Intern at Roblox. Applications submitted in the first week are 4x more likely to get a response.'
        ]
      },
      {
        subject: 'Devah, add machine learning to your skills?',
        body: [
          'People with your background who list machine learning get up to 2x more profile views. Add it to your profile in one tap and let recruiters find you.',
          'Skills are the first thing recruiters filter by when searching for interns. Your profile currently lists 6 skills; profiles with 10 or more get significantly more search impressions.'
        ]
      }
    ]
  },
  {
    from: { name: 'Canvas | bCourses', address: 'notifications@instructure.com' },
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Assignment graded: HW2 - Divide and Conquer',
        body: [
          "Your assignment HW2 - Divide and Conquer in EECS 101 has been graded. Score: 46/50. Instructor comment: 'Nice proof on Q3 — see rubric note about the recurrence.'",
          'Rubric breakdown: Q1 10/10, Q2 9/10, Q3 15/18, Q4 12/12. The Q3 deduction is for the unbalanced-split case of the recurrence, which needs its own bound.',
          'Regrade requests are open for 7 days via Gradescope. Class median: 41.'
        ]
      },
      {
        subject: 'New announcement in CDSS 101: Midterm 1 logistics',
        body: [
          'Midterm 1 will be held Thursday, Sept 18 from 7-9 PM in Wheeler 150. Seating assignments and allowed materials are posted on bCourses.',
          'The exam covers lectures 1 through 12 and homeworks 1 through 3. One handwritten sheet of notes (both sides) is allowed; no calculators or electronic devices.',
          'If you have a documented conflict or DSP accommodation, submit the alternate exam form by Friday at 5 PM.'
        ]
      },
      {
        subject: 'Due tomorrow: Lab 4 - Sampling Distributions',
        body: [
          'The following assignment is due tomorrow at 11:59 PM: Lab 4 - Sampling Distributions (CDSS 101). Late submissions lose 10% per day per the syllabus.',
          'The autograder gives instant feedback on the public tests; hidden tests run after the deadline. Remember to run the validation cell before exporting, or the submission may be unreadable.'
        ]
      }
    ]
  },
  {
    from: { name: 'Piazza', address: 'no-reply@piazza.com' },
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Instr note: HW3 deadline extended to Friday',
        body: [
          'Instructor note in EECS 101: Due to the volume of clarifications on Q2, HW3 is now due Friday at 11:59 PM. The autograder will reopen tonight.',
          'One clarification that affects many submissions: you may assume all input sizes are powers of two. The pinned clarification thread has the full list of assumptions.'
        ]
      },
      {
        subject: 'Your post has 3 new replies',
        body: [
          "Your question 'Does the greedy exchange argument need to cover ties?' in EECS 101 has 3 new replies, including one instructor response.",
          "Instructor response: 'Yes — handle ties explicitly, or argue WLOG that ties are broken by a fixed ordering. Either is fine for full credit, but say which one you are doing.'"
        ]
      }
    ]
  },
  {
    from: { name: 'Google Cloud', address: 'cloudplatform-noreply@google.com' },
    accountId: 'gmail',
    messages: [
      {
        subject: 'Your free trial credits expire in 14 days',
        body: [
          'You have $237.14 in Google Cloud credits expiring soon. Upgrade to a paid account to keep your projects running without interruption after the trial ends.',
          'Projects that will be affected: cs164-scraper and personal-site. When the trial ends, running resources are stopped and released after 30 days unless you upgrade.',
          'Upgrading keeps your free tier benefits, and you will not be charged until your usage exceeds them.'
        ]
      },
      {
        subject: 'Billing alert: cs164-scraper exceeded $5.00',
        body: [
          'Your budget alert for project cs164-scraper has been triggered. Current spend: $5.82 of your $5.00 budget (116%). Review Compute Engine usage to avoid further charges.',
          "Largest contributor: the e2-medium instance 'scraper-vm', which has been running continuously for 19 days. Consider stopping it when idle or switching to a preemptible instance."
        ]
      }
    ]
  },
  {
    from: { name: 'Handshake', address: 'handshake@notifications.joinhandshake.com' },
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Deloitte viewed your profile',
        body: [
          'Employers are interested. Deloitte and 2 other employers viewed your Handshake profile this week. Complete your profile to show up in more searches.',
          'Profiles with a resume, graduation date, and at least three skills get 5x more employer views. Yours is currently 80% complete — add your work experience to finish it.'
        ]
      },
      {
        subject: 'New on-campus interviews for Summer 2027 internships',
        body: [
          '12 employers just posted on-campus interview slots, including Amazon (SDE Intern), PG&E (Data Analyst Intern), and Genentech. OCI signups close Sunday.',
          'Priority deadline: Amazon SDE Intern closes Sunday at 11:59 PM and historically fills within a day. Interviews are held at the Career Center on Bancroft the following week.'
        ]
      },
      {
        subject: 'Reminder: Fall Career Fair is next Wednesday',
        body: [
          'The EECS + Data Science Career Fair is Wednesday, Sept 3 from 11 AM - 4 PM at the RSF Fieldhouse. 140+ employers attending. Upload your resume before you go.',
          'Tip from the career center: the first hour is the least crowded, and the employer list in the app shows which companies sponsor work authorization.',
          'Your QR check-in code is attached — screenshot it now to skip the registration line.'
        ]
      }
    ]
  },
  {
    from: { name: 'Berkeley EH&S', address: 'ehs@berkeley.edu' },
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Reminder: EHS 702 Heat Illness has been assigned to DEVAH SCHAEFERS',
        body: [
          'Dear DEVAH SCHAEFERS, This is a reminder that the training course EHS 702 Heat Illness Prevention has been assigned to you and must be completed within 30 days.',
          'This training is assigned based on your role in the campus registry and takes approximately 25 minutes. It can be completed on any device through the UC Learning Center.'
        ]
      },
      {
        subject: 'EHS 101 Safety Orientation - completion recorded',
        body: [
          'This confirms completion of EHS 101 Introduction to Safety on record for SCHAEFERS, DEVAH. Your certificate is available in the UC Learning Center.',
          'No further action is required at this time. Safety certificates remain valid for three years from the completion date.'
        ]
      }
    ]
  },
  {
    from: { name: 'Cal Student Central', address: 'studentcentral@berkeley.edu' },
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Fall 2026 CalCentral billing statement available',
        body: [
          'Your latest billing statement is now available on CalCentral. Amount due by Sept 15: $8,441.50. Financial aid disbursements post 10 days before the fee deadline.',
          'This term: tuition and student services fee $7,748.50, class pass $96.00, health insurance $693.00 (waiver window closes Sept 1), and a one-time document fee.',
          'Enroll in the Fee Payment Plan by Sept 10 to split the balance into five monthly installments with no interest.'
        ]
      },
      {
        subject: 'Enrollment appointment for Spring 2027 assigned',
        body: [
          'Your Phase 1 enrollment appointment begins Monday, Nov 2 at 8:40 AM. Review your planned schedule and enrollment units in CalCentral before your window opens.',
          'Phase 1 is limited to 13.5 units. Load your shopping cart in advance — seats in upper-division CS courses regularly fill within minutes of appointments opening.',
          'Students studying abroad in Spring 2027 should still enroll per their advising plan; units will reconcile once UCEAP registration posts.'
        ]
      }
    ]
  }
]

const PEOPLE_TEMPLATES: MsgTemplate[] = [
  {
    subject: 'Coffee before lecture?',
    body: [
      "Hey! I'm getting to campus around 9 tomorrow — want to grab coffee at V&A before 101? I also wanted to pick your brain about the KCL application.",
      'I finally got my nomination email last night and the acknowledgement form is confusingly worded. Did you already write the statement of purpose part, and how long did yours end up?',
      "If 9 is too early I can do 9:30 — lecture isn't until 10:10 anyway."
    ]
  },
  {
    subject: 'Midterm review sesh Sunday',
    body: [
      'A few of us are doing a review session Sunday before the midterm. I made a shared doc with past exam questions sorted by topic — can you add your solutions?',
      "We're starting at 3 in the Woz, unless it's booked, in which case Cory 241. I'll bring the practice midterm from two semesters ago — it's the only one with official solutions."
    ]
  },
  {
    subject: 'photos from Tahoe',
    body: [
      'Finally went through the photos from the Tahoe trip — the sunrise ones from the ridge came out insane. Album link below, download whatever you want.',
      "There is also a truly terrible one of you mid-sneeze at the summit that I'm keeping as leverage. The album link expires in 30 days, so grab what you want before then."
    ]
  },
  {
    subject: 'splitting the Costco run',
    body: [
      'Your share comes out to $23.40 — I got the oat milk you asked for and they were out of the good granola so I improvised. Venmo whenever.',
      "For the record the 'improvised' granola is better and I will not be taking questions. Receipt photo attached if you want to check my math."
    ]
  },
  {
    subject: 'game night saturday?',
    body: [
      "We're doing game night Saturday at the Fulton place — bring the weird euro game you keep threatening us with. 8pm, snacks are handled, byo-opinions about rules.",
      'RSVP so we know whether to set up the six-player table or the normal-people table.'
    ]
  },
  {
    subject: 'ride to SFO next week?',
    body: [
      "You mentioned you're flying out Thursday — I have the car that day and zero morning plans. Want a ride to SFO? Beats the BART transfer with two suitcases.",
      "Only condition is we leave with buffer, because I refuse to reenact the Great Terminal Sprint of last spring. I'll even spring for the good breakfast burritos on the way."
    ]
  },
  {
    subject: 'CalHacks team?',
    body: [
      'CalHacks signups opened this morning — are we doing this? I have an idea involving the campus shuttle API that is either very funny or actually useful, possibly both.',
      "We'd need a fourth. I was thinking of asking that friend of yours who did the map visualization thing — intro us if you think they'd be down?"
    ]
  },
  {
    subject: 'your mail keeps coming to the old place',
    body: [
      "Hey, you still get mail here — two things from the registrar and something that looks suspiciously like a jury summons. Want me to drop them at yours or hold them until you're around?",
      "I'm around all week except Wednesday. The jury one looks time-sensitive, just saying."
    ]
  },
  {
    subject: 'IM soccer — we need a sixth',
    body: [
      'Our IM team is down a player for the rest of the season and I remembered you claiming, in public, to be good. Games are Tuesday nights at Underhill, very low stakes, high vibes.',
      "First game is this Tuesday at 8. Cleats optional, the turf is forgiving. Say yes and I'll add you to the roster before the deadline."
    ]
  },
  {
    subject: 'borrowing your HDMI adapter',
    body: [
      "Took your HDMI adapter off your desk for my presentation this afternoon — telling you here so you don't tear the room apart looking for it. Back by 4, I promise.",
      'In exchange, there is a leftover boba in the fridge with your name on it. The good kind, not the one from the place we no longer discuss.'
    ]
  },
  {
    subject: 'apartment heater is doing the thing again',
    body: [
      "The heater is making the clanking noise again and I refuse to be gaslit about it this time — I recorded it. Sending the landlord an email tonight; reply if you want your name on it too.",
      'Also the kitchen faucet drips unless you close it at a very specific angle, which I have now mastered, but that should not be a skill.'
    ]
  },
  {
    subject: 'GSI section swap?',
    body: [
      "You're in the Tuesday 5pm section, right? I got a work conflict and need to swap into it — would you be willing to take my Thursday 11am? The GSI says it's fine if we both email him.",
      'Thursday GSI is the one who posts full solutions, if that sweetens the deal.'
    ]
  },
  {
    subject: 'saw this and thought of your project',
    body: [
      'That dataset you were hunting for the CDSS project — the city just published a cleaned version of it, updated monthly, with an actual data dictionary. Link below.',
      'The license is fine for coursework. There goes your best excuse for not starting.'
    ]
  }
]

interface InviteEvent {
  kind: 'Invitation' | 'Updated invitation' | 'Canceled event' | 'Accepted'
  title: string
  where: string
  start: number
  end: number
  fromUceap?: boolean
}

const INVITE_EVENTS: InviteEvent[] = [
  { kind: 'Invitation', title: 'EECS 144 Study Group', where: 'Moffitt Library, Room 405', start: 16, end: 18 },
  { kind: 'Updated invitation', title: 'Office Hours - Prof. Ranade', where: 'Soda Hall 511', start: 14, end: 15 },
  { kind: 'Invitation', title: 'CDSS 101 Project Sync', where: 'Google Meet', start: 17, end: 18 },
  {
    kind: 'Invitation',
    title: 'UCEAP Pre-Departure Orientation',
    where: 'International House, Chevron Auditorium',
    start: 10,
    end: 12,
    fromUceap: true
  },
  { kind: 'Accepted', title: 'Coffee with Devah', where: 'V&A Cafe', start: 9, end: 10 },
  { kind: 'Invitation', title: 'Apartment walkthrough - Milvia St', where: '2128 Milvia St, Berkeley', start: 15, end: 16 },
  { kind: 'Canceled event', title: 'Study Abroad Advising drop-in', where: 'Stephens Hall 160', start: 13, end: 14 },
  { kind: 'Invitation', title: 'Midterm 1 Review Session', where: 'Wheeler 150', start: 18, end: 20 },
  { kind: 'Updated invitation', title: 'EECS 144 Study Group', where: 'Moffitt Library, Room 405', start: 16, end: 18 }
]

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtEventDay(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`
}

function fmtHour(h: number): string {
  if (h === 12) return '12pm'
  return h < 12 ? `${h}am` : `${h - 12}pm`
}

function inviteBody(ev: InviteEvent, day: string, organizer: Mailbox): string[] {
  const organizerName = organizer.name ?? organizer.address
  const when = `${day}, ${fmtHour(ev.start)} - ${fmtHour(ev.end)} Pacific Time`
  switch (ev.kind) {
    case 'Invitation':
      return [
        `You have been invited to the following event. When: ${when}. Where: ${ev.where}. Organizer: ${organizerName}. Join with Google Meet.`,
        'Going? Respond Yes, No, or Maybe from your calendar. Your response is shared with the organizer, and other guests can see the updated attendee list.',
        'You are receiving this message because you are subscribed to calendar notifications for this account.'
      ]
    case 'Updated invitation':
      return [
        `This event has been updated. When: ${when}. Where: ${ev.where}. Note from the organizer: moved to avoid a conflict, same room.`,
        'Your previous RSVP has been carried over. If the new time no longer works, update your response from your calendar so the organizer has an accurate headcount.'
      ]
    case 'Canceled event':
      return [
        `This event has been canceled and removed from your calendar: ${ev.title}, ${when}.`,
        'Any notes or agenda items attached to this event remain viewable in your calendar trash for 30 days.'
      ]
    case 'Accepted':
      return [
        `${organizerName} has accepted this invitation. ${ev.title}, ${when}. Where: ${ev.where}.`,
        'This response has been recorded on your calendar. Current attendance: 2 yes, 0 no, 0 awaiting reply. No further action is needed.'
      ]
  }
}

// berkeley 40% / gmail 30% / college 10% / icloud 10% / abundant 10%
const ACCOUNT_WEIGHTS = [
  'berkeley',
  'berkeley',
  'berkeley',
  'berkeley',
  'gmail',
  'gmail',
  'gmail',
  'college',
  'icloud',
  'abundant'
]

function pickAccount(): string {
  return faker.helpers.arrayElement(ACCOUNT_WEIGHTS)
}

// Emails per day, day 0 = today. Denser toward now; sums to 150.
const DAY_COUNTS = [14, 12, 11, 10, 10, 9, 9, 8, 8, 7, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2]

const categoryDeck: Category[] = faker.helpers.shuffle([
  ...(Array(100).fill('notifications') as Category[]),
  ...(Array(26).fill('people') as Category[]),
  ...(Array(24).fill('invites') as Category[])
])

// Sent, drafts, spam, and conversations are hand-written above; the generated
// stream is inbox plus a handful of trash. Archive is carved out afterward.
// The first four slots (today's forced-inbox arrivals) stay out of the shuffle
// so the trash count lands exactly.
const folderDeck: Folder[] = [
  ...(Array(4).fill('inbox') as Folder[]),
  ...faker.helpers.shuffle([
    ...(Array(138).fill('inbox') as Folder[]),
    ...(Array(8).fill('trash') as Folder[])
  ])
]

const notifDeck = faker.helpers
  .shuffle(
    NOTIF_SOURCES.flatMap((src) =>
      src.messages.flatMap((msg) => [
        { src, msg },
        { src, msg },
        { src, msg }
      ])
    )
  )
  .slice(0, 100)

const peopleDeck = faker.helpers
  .shuffle([...PEOPLE_TEMPLATES, ...PEOPLE_TEMPLATES, ...PEOPLE_TEMPLATES])
  .slice(0, 26)

const inviteDeck = faker.helpers.shuffle([...INVITE_EVENTS, ...INVITE_EVENTS, ...INVITE_EVENTS]).slice(0, 24)

const generated: Message[] = []
let slot = 0
let peopleIdx = 0
let notifIdx = 0
let inviteIdx = 0

for (let dayIndex = 0; dayIndex < DAY_COUNTS.length; dayIndex++) {
  for (let j = 0; j < DAY_COUNTS[dayIndex]; j++) {
    let ms: number
    if (dayIndex === 0) {
      // First four of today land inside the last two hours (always unread).
      // Clamp to today's calendar day so early launches don't spill into yesterday.
      const startOfToday = new Date(NOW).setHours(0, 0, 0, 0)
      ms =
        j < 4
          ? Math.max(
              startOfToday + 10 * MINUTE,
              NOW - (20 + j * 30 + faker.number.int({ min: 0, max: 8 })) * MINUTE
            )
          : Math.max(
              startOfToday + 5 * MINUTE,
              NOW - faker.number.int({ min: 140, max: 600 }) * MINUTE
            )
    } else {
      const d = new Date(NOW - dayIndex * DAY)
      d.setHours(
        faker.number.int({ min: 7, max: 21 }),
        faker.number.int({ min: 0, max: 59 }),
        faker.number.int({ min: 0, max: 59 }),
        0
      )
      ms = d.getTime()
    }

    const category = categoryDeck[slot]
    const forcedInbox = dayIndex === 0 && j < 4
    const folder = forcedInbox ? 'inbox' : folderDeck[slot]

    let from: Mailbox
    let replyToMailbox: Mailbox | undefined
    let cc: Mailbox[] | undefined
    let subject: string
    let body: string[]
    let accountId: string

    if (category === 'notifications') {
      const { src, msg } = notifDeck[notifIdx++]
      from = src.from
      replyToMailbox = src.replyTo
      subject = msg.subject
      body = msg.body
      accountId = src.accountId
    } else if (category === 'people') {
      const msg = peopleDeck[peopleIdx]
      from = PEOPLE_POOL[peopleIdx % PEOPLE_POOL.length]
      subject = msg.subject
      body = msg.body
      accountId = pickAccount()
      // Occasional cc, like group mail among friends.
      if (peopleIdx % 6 === 2) {
        const extra = PEOPLE_POOL[(peopleIdx + 7) % PEOPLE_POOL.length]
        if (extra.address !== from.address) cc = [extra]
      }
      peopleIdx++
    } else {
      const ev = inviteDeck[inviteIdx]
      const organizer = ev.fromUceap ? UCEAP : NAMED_POOL[inviteIdx % NAMED_POOL.length]
      accountId = ev.fromUceap ? 'berkeley' : pickAccount()
      const eventDate = new Date(ms + faker.number.int({ min: 1, max: 6 }) * DAY)
      const day = fmtEventDay(eventDate)
      from = organizer
      subject = `${ev.kind}: ${ev.title} @ ${day} ${fmtHour(ev.start)} - ${fmtHour(ev.end)} (${identityOf(accountId).address})`
      body = inviteBody(ev, day, organizer)
      inviteIdx++
    }

    const ageMinutes = (NOW - ms) / MINUTE
    const seen = ageMinutes <= 120 ? false : faker.datatype.boolean(0.66)

    generated.push(
      push({
        from,
        to: [identityOf(accountId)],
        cc,
        replyTo: replyToMailbox,
        subject,
        date: ms,
        body,
        accountId,
        folder,
        seen,
        category
      })
    )
    slot++
  }
}

// ---------------------------------------------------------------------------
// Post-passes: archive ("done") backlog, the third flagged thread, importance.
// Picked by stepping through the stream (no faker) so the sequence stays put.
// ---------------------------------------------------------------------------

// Twelve older, read generated messages start archived so the Archive folder
// and the show-done toggle have content.
const archiveCandidates = generated.filter(
  (m) => m.folder === 'inbox' && m.flags.seen && (NOW - Date.parse(m.date)) / DAY >= 3
)
const stepped = archiveCandidates.filter((_, i) => i % 5 === 0)
const rest = archiveCandidates.filter((_, i) => i % 5 !== 0)
for (const m of [...stepped, ...rest].slice(0, 12)) m.folder = 'archive'

// Flag the KCL nomination notice (third flagged thread, alongside Mom + Priya).
const kclNomination = generated.find(
  (m) => m.folder === 'inbox' && m.subject === 'Nomination for Study Abroad at KCL - next step'
)
if (kclNomination) kclNomination.flags.flagged = true

built.sort((a, b) => b.date.localeCompare(a.date))

// Eight important messages: four from today and four from yesterday, preferring
// people, then urgent notifications.
const urgentRe = /ACTION REQUIRED|Overdue|MUST READ|Action needed|due tomorrow|due soon/i
function importanceRank(m: Message): number {
  if (m.category === 'people') return 0
  if (m.category === 'notifications' && urgentRe.test(m.subject)) return 1
  if (m.category === 'notifications') return 2
  return 3
}
function dayIndexOf(m: Message): number {
  return Math.floor((NOW - Date.parse(m.date)) / DAY)
}
for (const day of [0, 1]) {
  const picks = built
    .filter((m) => m.folder === 'inbox' && dayIndexOf(m) === day)
    .sort((a, b) => importanceRank(a) - importanceRank(b))
    .slice(0, 4)
  for (const m of picks) m.important = true
}

export const messages: Message[] = built

// ---------------------------------------------------------------------------
// Live "just arrived" messages for the refresh action. Plain rotation keyed by
// existingCount — no faker at call time, so the seeded stream stays stable.
// One rotation entry is a real reply into the seeded "Dinner Friday?" thread,
// so refreshing can grow a conversation.
// ---------------------------------------------------------------------------

interface IncomingTemplate {
  from: Mailbox
  accountId: string
  category: Category
  subject: string
  body: string[]
  inReplyTo?: string
  references?: string[]
}

const INCOMING_TEMPLATES: IncomingTemplate[] = [
  {
    from: { name: 'Piazza', address: 'no-reply@piazza.com' },
    accountId: 'berkeley',
    category: 'notifications',
    subject: 'Your post has 1 new reply',
    body: [
      "Your question 'Does the greedy exchange argument need to cover ties?' in EECS 101 has a new reply.",
      "The reply reads: 'Following up on the instructor answer — the WLOG route is shorter if you fix the ordering up front. I wrote mine that way and it came out to half a page.'",
      'Reply directly from Piazza to continue the discussion.'
    ]
  },
  {
    from: { name: 'GitHub', address: 'notifications@github.com' },
    accountId: 'gmail',
    category: 'notifications',
    subject: '[cs164-project] alexwang requested your review on #47',
    body: [
      "alexwang requested your review on pull request #47: Add constant folding pass. 'Small one — mostly tests. Want your eyes on the overflow handling before I merge.'",
      "From the PR description: 'Folds integer arithmetic on literals at parse time. Overflow falls back to leaving the expression unfolded rather than wrapping, so runtime behavior is unchanged.'",
      '4 files changed, +186 -12. CI is green.'
    ]
  },
  {
    from: JORDAN,
    accountId: 'berkeley',
    category: 'people',
    subject: 'you around?',
    body: [
      "are you in Soda rn? I'm on the 3rd floor and the HW3 autograder just reopened — it's accepting the powers-of-two assumption now, so my part (c) finally passes.",
      'come find me if you want to rerun yours before the queue gets long. also I have your pen.'
    ]
  },
  {
    from: UCEAP,
    accountId: 'berkeley',
    category: 'notifications',
    subject: 'Reminder: visa appointment documentation due this week',
    body: [
      'Dear Devah, This is a reminder that your UK Student visa appointment confirmation and supporting documentation are due in your UCEAP Portal by Friday at 5:00 PM.',
      'Upload a copy of your appointment confirmation email and your CAS statement to the Documents tab. Items are reviewed within two business days.',
      'If you have not yet booked an appointment, the San Francisco application centre is currently booking about three weeks out — schedule as soon as possible.'
    ]
  },
  {
    from: { name: 'Canvas | bCourses', address: 'notifications@instructure.com' },
    accountId: 'berkeley',
    category: 'notifications',
    subject: 'Assignment graded: Lab 4 - Sampling Distributions',
    body: [
      "Your assignment Lab 4 - Sampling Distributions in CDSS 101 has been graded. Score: 19/20. Instructor comment: 'Clean bootstrap implementation — nice catch on the resampling footnote.'",
      'The hidden tests all passed; the one-point deduction is on the written interpretation question. Class median: 16.',
      'Regrade requests are open for 7 days via Gradescope.'
    ]
  },
  {
    // A proper reply into the seeded dinner thread: refresh grows a conversation.
    from: SARAH,
    accountId: 'gmail',
    category: 'people',
    subject: 'Re: Dinner Friday?',
    inReplyTo: dinnerM2.messageId,
    references: [dinnerM1.messageId, dinnerM2.messageId],
    body: [
      "Update on Thai Friday: Marcus escaped his section, so we're six now. I moved the reservation to 7:15 so we actually get the big table.",
      "Also we're doing a group gift situation for your going-away — I'm telling you now so you act surprised competently. You didn't hear it from me."
    ]
  }
]

let incomingSeq = 0

/** A fresh unread inbox message dated now; rotation by existingCount keeps it faker-free. */
export function makeIncomingMessage(existingCount: number): Message {
  const t = INCOMING_TEMPLATES[existingCount % INCOMING_TEMPLATES.length]
  incomingSeq += 1
  return {
    messageId: `<live-${incomingSeq}-${Date.now()}@${t.from.address.split('@')[1]}>`,
    inReplyTo: t.inReplyTo,
    references: t.references ? [...t.references] : [],
    from: t.from,
    to: [identityOf(t.accountId)],
    cc: [],
    subject: t.subject,
    date: new Date().toISOString(),
    body: t.body,
    accountId: t.accountId,
    folder: 'inbox',
    flags: { seen: false, flagged: false, answered: false },
    category: t.category,
    important: false
  }
}
