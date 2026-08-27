import { faker } from '@faker-js/faker'
import type { Account, Category, Email, Folder, Sender } from './types'

faker.seed(1337)

export const accounts: Account[] = [
  { id: 'gmail', name: 'Gmail', email: 'devah.schaefers@gmail.com', color: '#EA4335' },
  { id: 'college', name: 'College', email: 'dschaefers@college.edu', color: '#00897B' },
  { id: 'berkeley', name: 'Berkeley', email: 'devah@berkeley.edu', color: '#7B1FA2' },
  { id: 'icloud', name: 'iCloud', email: 'devah@icloud.com', color: '#5C6BC0' },
  { id: 'abundant', name: 'Abundant', email: 'devah@abundant.io', color: '#C2185B' }
]

// Spark avatar palette; color is stable per sender name.
const AVATAR_PALETTE = [
  '#6623FF',
  '#2196F3',
  '#EC00AF',
  '#C56BDA',
  '#43A047',
  '#FF7043',
  '#0288D1',
  '#7B1FA2',
  '#00897B',
  '#5C6BC0',
  '#D81B60',
  '#F4511E'
]

function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((w) => /[a-z]/i.test(w))
  return words
    .slice(0, 2)
    .map((w) => w.replace(/[^a-z]/gi, '').charAt(0).toUpperCase())
    .join('')
}

function makeSender(name: string, email: string): Sender {
  return { name, email, color: avatarColor(name), initials: initialsOf(name) }
}

interface MsgTemplate {
  subject: string
  preview: string
}

interface NotifSource {
  sender: Sender
  accountId: string
  messages: MsgTemplate[]
}

const NOTIF_SOURCES: NotifSource[] = [
  {
    sender: makeSender('Berkeley Study Abroad - UCEAP', 'studyabroad@berkeley.edu'),
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Overdue Acknowledgement of Nomination Requirement',
        preview:
          'Dear Devah, You have not completed one or more of the Action Items in your UCEAP Portal. The Acknowledgement of Nomination is now overdue and must be submitted before we can release your placement.'
      },
      {
        subject: "UCEAP ACTION REQUIRED - MUST READ - KING'S COLLEGE LONDON",
        preview:
          "Dear Student, Congratulations on your nomination to King's College London for Spring 2027. Before we can proceed, you must review the attached program agreement and confirm your participation."
      },
      {
        subject: 'Nomination for Study Abroad at KCL - next step',
        preview:
          "Hi Devah, Great news — your nomination has been forwarded to King's College London. The next step is to complete the KCL online application through King's Apply within 14 days."
      },
      {
        subject: 'Pre-Departure Checklist: 45 days to go',
        preview:
          'Dear Devah, Your program start date is approaching. Please review your pre-departure checklist: passport validity, visa appointment, flight itinerary, and proof of insurance are still outstanding.'
      },
      {
        subject: 'Reminder: Study Abroad 101 Webinar this Thursday',
        preview:
          'Join us Thursday at 4:00 PM PT for Study Abroad 101, covering budgeting, housing, and academic planning for your term abroad. Registration closes Wednesday at noon.'
      }
    ]
  },
  {
    sender: makeSender('noreplyuclc@berkeley.edu', 'noreplyuclc@berkeley.edu'),
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Your UC Learning Center transcript',
        preview:
          'This is an automated message from the UC Learning Center. Your training transcript has been updated. Log in to view your completed and assigned activities.'
      },
      {
        subject: 'Assigned Training: Cybersecurity Awareness 2026',
        preview:
          'The following training has been assigned to you in the UC Learning Center: Cybersecurity Awareness Fundamentals. Due date: 30 days from assignment. This activity is required for all active students.'
      },
      {
        subject: 'Training due soon: 3 items require completion',
        preview:
          'This is a reminder that you have 3 assigned training activities due within the next 14 days. Please log in to the UC Learning Center to complete them before the deadline.'
      }
    ]
  },
  {
    sender: makeSender('Ed', 'no-reply@edstem.org'),
    accountId: 'berkeley',
    messages: [
      {
        subject: 'New threads in EECS 101 and CDSS 101',
        preview:
          "You have new activity in your courses. EECS 101: 'Clarification on HW3 Q2 runtime bounds' and 4 more threads. CDSS 101: 'Project 1 rubric posted' and 2 more."
      },
      {
        subject: 'Instructor endorsed your answer in EECS 101',
        preview:
          "Your answer to 'Is memoization required for full credit on Q4?' was endorsed by an instructor. View the thread to see follow-up comments from your classmates."
      },
      {
        subject: 'Reply to your question in CDSS 101',
        preview:
          "Someone replied to your thread 'Confused about the bootstrap sampling step in lab 4'. Click through to view the reply and continue the discussion."
      },
      {
        subject: 'Weekly digest: 23 new posts in your courses',
        preview:
          "Here's what you missed this week on Ed. EECS 101: 14 new threads and 3 announcements. CDSS 101: 6 new threads, including 'Midterm logistics megathread'."
      }
    ]
  },
  {
    sender: makeSender('KCL - StudyAbroad', 'studyabroad@kcl.ac.uk'),
    accountId: 'berkeley',
    messages: [
      {
        subject: "King's Apply: your application has been received",
        preview:
          "Dear Applicant, Thank you for submitting your Study Abroad application to King's College London. Your application ID is 2027-SA-08841. We aim to respond within 15 working days."
      },
      {
        subject: 'Module selection now open for Study Abroad students',
        preview:
          "Dear Incoming Student, Module selection for the Spring term is now open in King's Apply. Please select four modules and two reserves before the stated deadline."
      },
      {
        subject: 'Action needed: upload your official transcript',
        preview:
          "Dear Devah, Our records show your application is missing an official transcript. Please upload a PDF copy via King's Apply within 10 working days to avoid delays."
      }
    ]
  },
  {
    sender: makeSender('London Study Center', 'info@londonstudycenter.org'),
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Housing options for Spring 2027 now live',
        preview:
          'Hello future Londoner! Our Spring 2027 housing portal is now open. Options include ensuite rooms in Zone 1 student halls from £285/week, with flexible contract lengths for study abroad students.'
      },
      {
        subject: 'Your London arrival guide',
        preview:
          'From Heathrow to your halls: everything you need for arrival week, including the Piccadilly line, Oyster cards versus contactless, and where to get a UK SIM on day one.'
      }
    ]
  },
  {
    sender: makeSender('GitHub', 'notifications@github.com'),
    accountId: 'gmail',
    messages: [
      {
        subject: '[GitHub] Your Dependabot alerts digest',
        preview:
          'We found 3 vulnerabilities in devahs/cs164-project. 1 high severity in lodash < 4.17.21 and 2 moderate in webpack-dev-server. Review and dismiss or upgrade.'
      },
      {
        subject: '[GitHub] Please verify your device',
        preview:
          'Hey devahs! A sign-in attempt requires further verification because we did not recognize your device. Your device verification code is 481-229.'
      },
      {
        subject: '[devahs/eecs101-hw] CI failed on push to main',
        preview:
          'Run failed: test-suite (ubuntu-latest). 2 of 47 checks failed in 3m 12s. FAIL test/scheduler.test.ts — expected quantum 4 to preempt at tick 12.'
      },
      {
        subject: '[cs164-project] alexwang requested your review on #42',
        preview:
          "alexwang requested your review on pull request #42: Refactor parser to handle nested scopes. 'Can you double-check the symbol table changes before I merge?'"
      }
    ]
  },
  {
    sender: makeSender('LinkedIn', 'messages-noreply@linkedin.com'),
    accountId: 'gmail',
    messages: [
      {
        subject: 'You appeared in 9 searches this week',
        preview:
          "You're getting noticed. You appeared in 9 searches this week, including searchers from Google, Databricks, and a stealth startup. See who's looking."
      },
      {
        subject: "New jobs for 'software engineering intern' in Berkeley",
        preview:
          '24 new jobs match your alert. Software Engineering Intern at Stripe, SWE Intern - Summer 2027 at Nvidia, and 22 more. Apply early to stand out.'
      },
      {
        subject: 'Devah, add machine learning to your skills?',
        preview:
          'People with your background who list machine learning get up to 2x more profile views. Add it to your profile in one tap and let recruiters find you.'
      }
    ]
  },
  {
    sender: makeSender('Canvas | bCourses', 'notifications@instructure.com'),
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Assignment graded: HW2 - Divide and Conquer',
        preview:
          "Your assignment HW2 - Divide and Conquer in EECS 101 has been graded. Score: 46/50. Instructor comment: 'Nice proof on Q3 — see rubric note about the recurrence.'"
      },
      {
        subject: 'New announcement in CDSS 101: Midterm 1 logistics',
        preview:
          'Midterm 1 will be held Thursday, Sept 18 from 7-9 PM in Wheeler 150. Seating assignments and allowed materials are posted on bCourses.'
      },
      {
        subject: 'Due tomorrow: Lab 4 - Sampling Distributions',
        preview:
          'The following assignment is due tomorrow at 11:59 PM: Lab 4 - Sampling Distributions (CDSS 101). Late submissions lose 10% per day per the syllabus.'
      }
    ]
  },
  {
    sender: makeSender('Piazza', 'no-reply@piazza.com'),
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Instr note: HW3 deadline extended to Friday',
        preview:
          'Instructor note in EECS 101: Due to the volume of clarifications on Q2, HW3 is now due Friday at 11:59 PM. The autograder will reopen tonight.'
      },
      {
        subject: 'Your post has 3 new replies',
        preview:
          "Your question 'Does the greedy exchange argument need to cover ties?' in EECS 101 has 3 new replies, including one instructor response."
      }
    ]
  },
  {
    sender: makeSender('Google Cloud', 'CloudPlatform-noreply@google.com'),
    accountId: 'gmail',
    messages: [
      {
        subject: 'Your free trial credits expire in 14 days',
        preview:
          'You have $237.14 in Google Cloud credits expiring soon. Upgrade to a paid account to keep your projects running without interruption after the trial ends.'
      },
      {
        subject: 'Billing alert: cs164-scraper exceeded $5.00',
        preview:
          'Your budget alert for project cs164-scraper has been triggered. Current spend: $5.82 of your $5.00 budget (116%). Review Compute Engine usage to avoid further charges.'
      }
    ]
  },
  {
    sender: makeSender('Handshake', 'handshake@notifications.joinhandshake.com'),
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Deloitte viewed your profile',
        preview:
          'Employers are interested. Deloitte and 2 other employers viewed your Handshake profile this week. Complete your profile to show up in more searches.'
      },
      {
        subject: 'New on-campus interviews for Summer 2027 internships',
        preview:
          '12 employers just posted on-campus interview slots, including Amazon (SDE Intern), PG&E (Data Analyst Intern), and Genentech. OCI signups close Sunday.'
      },
      {
        subject: 'Reminder: Fall Career Fair is next Wednesday',
        preview:
          'The EECS + Data Science Career Fair is Wednesday, Sept 3 from 11 AM - 4 PM at the RSF Fieldhouse. 140+ employers attending. Upload your resume before you go.'
      }
    ]
  },
  {
    sender: makeSender('Berkeley EH&S', 'ehs@berkeley.edu'),
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Reminder: EHS 702 Heat Illness has been assigned to DEVAH SCHAEFERS',
        preview:
          'Dear DEVAH SCHAEFERS, This is a reminder that the training course EHS 702 Heat Illness Prevention has been assigned to you and must be completed within 30 days.'
      },
      {
        subject: 'EHS 101 Safety Orientation - completion recorded',
        preview:
          'This confirms completion of EHS 101 Introduction to Safety on record for SCHAEFERS, DEVAH. Your certificate is available in the UC Learning Center.'
      }
    ]
  },
  {
    sender: makeSender('Cal Student Central', 'studentcentral@berkeley.edu'),
    accountId: 'berkeley',
    messages: [
      {
        subject: 'Fall 2026 CalCentral billing statement available',
        preview:
          'Your latest billing statement is now available on CalCentral. Amount due by Sept 15: $8,441.50. Financial aid disbursements post 10 days before the fee deadline.'
      },
      {
        subject: 'Enrollment appointment for Spring 2027 assigned',
        preview:
          'Your Phase 1 enrollment appointment begins Monday, Nov 2 at 8:40 AM. Review your planned schedule and enrollment units in CalCentral before your window opens.'
      }
    ]
  }
]

const PEOPLE_MESSAGES: MsgTemplate[] = [
  {
    subject: 'Coffee before lecture?',
    preview:
      "Hey! I'm getting to campus around 9 tomorrow — want to grab coffee at V&A before 101? I also wanted to pick your brain about the KCL application."
  },
  {
    subject: "Notes from today's discussion",
    preview:
      'Hey Devah, here are my notes from discussion today. I flagged the part about exchange arguments since the GSI hinted it shows up on the midterm.'
  },
  {
    subject: 'Re: housing in London',
    preview:
      'Ok so I looked at the halls you sent — Stamford Street is way closer to campus but Goodenough College looks amazing. My cousin says Zone 2 is fine if you get a room near the Tube.'
  },
  {
    subject: 'Re: study group this weekend',
    preview:
      "Saturday works for me! Moffitt 4th floor at 2? I reserved a room just in case. Bring your HW3 attempt — I'm stuck on the last part too."
  },
  {
    subject: 'you left your charger in Soda',
    preview:
      "pretty sure this is yours — it was on the table in 380 after we left. I'll be in the Woz until 5 if you want to come grab it."
  },
  {
    subject: 'Spring sublease?',
    preview:
      "Hey! Heard you're going abroad in the spring — are you planning to sublease your room? My friend is transferring in January and needs a place near campus."
  },
  {
    subject: 'Re: flight to Heathrow',
    preview:
      'I found a nonstop SFO-LHR on the 8th for $612 if we book by Friday. If we land together we can split the Heathrow Express, or honestly the Piccadilly line is fine.'
  },
  {
    subject: 'Midterm review sesh Sunday',
    preview:
      'A few of us are doing a review session Sunday before the midterm. I made a shared doc with past exam questions sorted by topic — can you add your solutions?'
  },
  {
    subject: 'Dinner Friday?',
    preview:
      "We're doing Thai on Telegraph before you disappear to London forever. Friday 7pm, usual spot. Say yes."
  },
  {
    subject: 'Quick question about the CDSS lab',
    preview:
      "Hey, in lab 4 did your confidence interval come out around (0.42, 0.58)? Mine looks suspicious and I can't tell if I'm bootstrapping wrong or the data is just like that."
  },
  {
    subject: 'Re: recommendation letter',
    preview:
      "Hi Devah, I'd be glad to write in support of your application. Could you send me your resume, transcript, and a short paragraph on the program by end of next week?"
  },
  {
    subject: 'photos from Tahoe',
    preview:
      'Finally went through the photos from the Tahoe trip — the sunrise ones from the ridge came out insane. Album link below, download whatever you want.'
  },
  {
    subject: 'Re: splitting the Costco run',
    preview:
      'Your share comes out to $23.40 — I got the oat milk you asked for and they were out of the good granola so I improvised. Venmo whenever.'
  },
  {
    subject: 'did you see the Stripe posting',
    preview:
      'The Stripe intern posting just went up on Handshake and it closes in two weeks. We should do a mock interview swap before then — are you free Tuesday?'
  },
  {
    subject: "Re: Notes from today's discussion",
    preview:
      'These are so good, thank you!! The tie-breaking part finally clicked. Trade you for my CDSS notes — also did you start the project yet or are we both doomed?'
  },
  {
    subject: 'intro to my friend at KCL',
    preview:
      "Devah — meet Priya, she's a second-year at King's and lived in Stamford Street last year. Priya, Devah's headed to KCL in the spring and has housing questions."
  }
]

const MOM = makeSender('Mom', 'linda.schaefers@comcast.net')

const MOM_MESSAGES: MsgTemplate[] = [
  {
    subject: 'checking in',
    preview:
      "Hi sweetheart, Dad and I were talking about your London plans last night. Have you heard back about housing yet? Grandma wants to know if you'll be home for Thanksgiving before you go."
  },
  {
    subject: 'Fwd: Your flight confirmation',
    preview:
      'Forwarding this so you have a copy too. Dad says to book the airport shuttle early. Also call your grandmother, she asked about you twice this week.'
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

function invitePreview(ev: InviteEvent, day: string, organizer: Sender): string {
  const when = `${day}, ${fmtHour(ev.start)} - ${fmtHour(ev.end)} Pacific Time`
  switch (ev.kind) {
    case 'Invitation':
      return `You have been invited to the following event. When: ${when}. Where: ${ev.where}. Organizer: ${organizer.name}. Join with Google Meet.`
    case 'Updated invitation':
      return `This event has been updated. When: ${when}. Where: ${ev.where}. Note from the organizer: moved to avoid a conflict, same room.`
    case 'Canceled event':
      return `This event has been canceled and removed from your calendar: ${ev.title}, ${when}.`
    case 'Accepted':
      return `${organizer.name} has accepted this invitation. ${ev.title}, ${when}. Where: ${ev.where}.`
  }
}

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const NOW = Date.now()

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

const peoplePool: Sender[] = Array.from({ length: 20 }, () => {
  const firstName = faker.person.firstName()
  const lastName = faker.person.lastName()
  return makeSender(`${firstName} ${lastName}`, faker.internet.email({ firstName, lastName }).toLowerCase())
})

// Emails per day, day 0 = today. Denser toward now; sums to 180.
const DAY_COUNTS = [16, 14, 13, 12, 11, 11, 10, 9, 8, 8, 8, 7, 7, 7, 6, 6, 6, 6, 5, 5, 5]
const TOTAL = 180

const categoryDeck: Category[] = faker.helpers.shuffle([
  ...(Array(108).fill('notifications') as Category[]),
  ...(Array(45).fill('people') as Category[]),
  ...(Array(27).fill('invites') as Category[])
])

const folderDeck: Folder[] = faker.helpers.shuffle([
  ...(Array(162).fill('inbox') as Folder[]),
  ...(Array(8).fill('sent') as Folder[]),
  ...(Array(4).fill('drafts') as Folder[]),
  ...(Array(3).fill('trash') as Folder[]),
  ...(Array(3).fill('spam') as Folder[])
])

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
  .slice(0, 108)

const peopleDeck = faker.helpers.shuffle([...PEOPLE_MESSAGES, ...PEOPLE_MESSAGES, ...PEOPLE_MESSAGES]).slice(0, 45)

const inviteDeck = faker.helpers.shuffle([...INVITE_EVENTS, ...INVITE_EVENTS, ...INVITE_EVENTS]).slice(0, 27)

interface Draft {
  ms: number
  dayIndex: number
  accountId: string
  sender: Sender
  subject: string
  preview: string
  category: Category
  read: boolean
  important: boolean
  pinned: boolean
  folder: Folder
}

const drafts: Draft[] = []
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

    let sender: Sender
    let subject: string
    let preview: string
    let accountId: string

    if (category === 'notifications') {
      const { src, msg } = notifDeck[notifIdx++]
      sender = src.sender
      subject = msg.subject
      preview = msg.preview
      accountId = src.accountId
    } else if (category === 'people') {
      if (peopleIdx === 4 || peopleIdx === 22) {
        const msg = MOM_MESSAGES[peopleIdx === 4 ? 0 : 1]
        sender = MOM
        subject = msg.subject
        preview = msg.preview
        accountId = 'gmail'
      } else {
        const msg = peopleDeck[peopleIdx]
        sender = faker.helpers.arrayElement(peoplePool)
        subject = msg.subject
        preview = msg.preview
        accountId = pickAccount()
      }
      peopleIdx++
    } else {
      const ev = inviteDeck[inviteIdx++]
      const organizer = ev.fromUceap ? NOTIF_SOURCES[0].sender : faker.helpers.arrayElement(peoplePool)
      const eventDate = new Date(ms + faker.number.int({ min: 1, max: 6 }) * DAY)
      const day = fmtEventDay(eventDate)
      sender = organizer
      subject = `${ev.kind}: ${ev.title} @ ${day} ${fmtHour(ev.start)} - ${fmtHour(ev.end)} (devah@berkeley.edu)`
      preview = invitePreview(ev, day, organizer)
      accountId = ev.fromUceap ? 'berkeley' : pickAccount()
    }

    const ageMinutes = (NOW - ms) / MINUTE
    const read =
      folder === 'sent' || folder === 'drafts'
        ? true
        : ageMinutes <= 120
          ? false
          : faker.datatype.boolean(0.72)

    drafts.push({
      ms,
      dayIndex,
      accountId,
      sender,
      subject,
      preview,
      category,
      read,
      important: false,
      pinned: false,
      folder
    })
    slot++
  }
}

drafts.sort((a, b) => b.ms - a.ms)

// Exactly 8 important emails, four from today and four from yesterday,
// preferring people then urgent notifications.
const recent = drafts.filter((d) => d.dayIndex <= 1 && d.folder === 'inbox')
const urgentRe = /ACTION REQUIRED|Overdue|MUST READ|Action needed|due tomorrow|due soon/i
function importanceRank(d: Draft): number {
  if (d.category === 'people') return 0
  if (d.category === 'notifications' && urgentRe.test(d.subject)) return 1
  if (d.category === 'notifications') return 2
  return 3
}
const importantPicks = [0, 1].flatMap((day) =>
  recent
    .filter((d) => d.dayIndex === day)
    .sort((a, b) => importanceRank(a) - importanceRank(b))
    .slice(0, 4)
)
for (const d of importantPicks) d.important = true

// Two to three pinned emails.
const pinnedPicks = new Set<Draft>()
if (importantPicks.length > 0) pinnedPicks.add(importantPicks[0])
const olderPerson = drafts.find((d) => d.dayIndex >= 3 && d.category === 'people' && d.folder === 'inbox')
if (olderPerson) pinnedPicks.add(olderPerson)
const kclNomination = drafts.find(
  (d) => d.subject === 'Nomination for Study Abroad at KCL - next step' && d.folder === 'inbox'
)
if (kclNomination) pinnedPicks.add(kclNomination)
for (const d of pinnedPicks) d.pinned = true

export const emails: Email[] = drafts.slice(0, TOTAL).map((d, i) => ({
  id: `email-${String(i + 1).padStart(3, '0')}`,
  accountId: d.accountId,
  sender: d.sender,
  subject: d.subject,
  preview: d.preview,
  date: new Date(d.ms).toISOString(),
  category: d.category,
  read: d.read,
  important: d.important,
  pinned: d.pinned,
  folder: d.folder
}))
