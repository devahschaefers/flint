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

/** First ~140 chars of body[0], cut at a word boundary, so previews always agree with the message. */
function previewOf(body: string[]): string {
  const first = body[0]
  if (first.length <= 140) return first
  const cut = first.slice(0, 140)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : 140)}…`
}

interface MsgTemplate {
  subject: string
  body: string[]
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
        subject: 'Pre-Departure Checklist: 45 days to go',
        body: [
          'Dear Devah, Your program start date is approaching. Please review your pre-departure checklist: passport validity, visa appointment, flight itinerary, and proof of insurance are still outstanding.',
          'Your passport must be valid for at least six months beyond your program end date. UK Student visa appointments at the San Francisco application centre are currently booking about three weeks out, so schedule yours now.',
          'Upload each document to the portal as you complete it. Items are reviewed within two business days and you will be notified of anything that needs correction.'
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
    sender: makeSender('noreplyuclc@berkeley.edu', 'noreplyuclc@berkeley.edu'),
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
    sender: makeSender('Ed', 'no-reply@edstem.org'),
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
    sender: makeSender('KCL - StudyAbroad', 'studyabroad@kcl.ac.uk'),
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
    sender: makeSender('London Study Center', 'info@londonstudycenter.org'),
    accountId: 'berkeley',
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
    sender: makeSender('GitHub', 'notifications@github.com'),
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
    sender: makeSender('LinkedIn', 'messages-noreply@linkedin.com'),
    accountId: 'gmail',
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
    sender: makeSender('Canvas | bCourses', 'notifications@instructure.com'),
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
    sender: makeSender('Piazza', 'no-reply@piazza.com'),
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
    sender: makeSender('Google Cloud', 'CloudPlatform-noreply@google.com'),
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
    sender: makeSender('Handshake', 'handshake@notifications.joinhandshake.com'),
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
    sender: makeSender('Berkeley EH&S', 'ehs@berkeley.edu'),
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
    sender: makeSender('Cal Student Central', 'studentcentral@berkeley.edu'),
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

const PEOPLE_MESSAGES: MsgTemplate[] = [
  {
    subject: 'Coffee before lecture?',
    body: [
      "Hey! I'm getting to campus around 9 tomorrow — want to grab coffee at V&A before 101? I also wanted to pick your brain about the KCL application.",
      'I finally got my nomination email last night and the acknowledgement form is confusingly worded. Did you already write the statement of purpose part, and how long did yours end up?',
      "If 9 is too early I can do 9:30 — lecture isn't until 10:10 anyway."
    ]
  },
  {
    subject: "Notes from today's discussion",
    body: [
      'Hey Devah, here are my notes from discussion today. I flagged the part about exchange arguments since the GSI hinted it shows up on the midterm.',
      "The worked example on slide 14 is the one he called 'exam-adjacent', so I typed that one up in full. My handwriting on the proof sketch got bad toward the end — ping me if a step doesn't make sense.",
      "Doc is in our shared folder under 'disc-week4'."
    ]
  },
  {
    subject: 'Re: housing in London',
    body: [
      'Ok so I looked at the halls you sent — Stamford Street is way closer to campus but Goodenough College looks amazing. My cousin says Zone 2 is fine if you get a room near the Tube.',
      "Also apparently Goodenough has a formal dinner thing, which is either amazing or deeply weird and I genuinely can't tell. Stamford Street is like eight minutes to campus though, and you hate commuting.",
      "Want to just call tonight and go through the options together? I'm free after 8."
    ]
  },
  {
    subject: 'Re: study group this weekend',
    body: [
      "Saturday works for me! Moffitt 4th floor at 2? I reserved a room just in case. Bring your HW3 attempt — I'm stuck on the last part too.",
      "Can we also spend 20 minutes on the exchange argument material before we start? I have the general shape but I keep hand-waving the tie-breaking case, and I know that's exactly where they get you."
    ]
  },
  {
    subject: 'you left your charger in Soda',
    body: [
      "pretty sure this is yours — it was on the table in 380 after we left. I'll be in the Woz until 5 if you want to come grab it.",
      "It's the 96W one with the sticker, so I figured you'd want it back before your laptop dies mid-lecture again."
    ]
  },
  {
    subject: 'Spring sublease?',
    body: [
      "Hey! Heard you're going abroad in the spring — are you planning to sublease your room? My friend is transferring in January and needs a place near campus.",
      "She's clean, quiet, and has a cat (deal-breaker? be honest). She can do $1,100 plus utilities, and the timing lines up with your program almost exactly — January through May.",
      'No pressure either way, just let me know before you list it anywhere else.'
    ]
  },
  {
    subject: 'Re: flight to Heathrow',
    body: [
      'I found a nonstop SFO-LHR on the 8th for $612 if we book by Friday. If we land together we can split the Heathrow Express, or honestly the Piccadilly line is fine.',
      "The return leg is the annoying part — flying back on a Saturday adds like $150. I say we book the outbound now and sort returns later, since your program end date isn't final anyway.",
      "Sending you the Google Flights link — fare-lock it if you're not ready to commit."
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
    subject: 'Dinner Friday?',
    body: [
      "We're doing Thai on Telegraph before you disappear to London forever. Friday 7pm, usual spot. Say yes.",
      "Sarah's in, Marcus is a maybe because of his 6pm section. If we get there before 7 we can actually get the big table in the back."
    ]
  },
  {
    subject: 'Quick question about the CDSS lab',
    body: [
      "Hey, in lab 4 did your confidence interval come out around (0.42, 0.58)? Mine looks suspicious and I can't tell if I'm bootstrapping wrong or the data is just like that.",
      'I reran it with 10,000 resamples instead of 1,000 and it barely moved, so now I suspect my cleaning step. Did you drop the null rows before or after splitting?'
    ]
  },
  {
    subject: 'Re: recommendation letter',
    body: [
      "Hi Devah, I'd be glad to write in support of your application. Could you send me your resume, transcript, and a short paragraph on the program by end of next week?",
      'It also helps if you remind me which assignments from my course you were proudest of — specifics make these letters much stronger than generalities.',
      'And confirm the deadline for me, please. I want to make sure it goes in well ahead of time.'
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
    subject: 'Re: splitting the Costco run',
    body: [
      'Your share comes out to $23.40 — I got the oat milk you asked for and they were out of the good granola so I improvised. Venmo whenever.',
      "For the record the 'improvised' granola is better and I will not be taking questions. Receipt photo attached if you want to check my math."
    ]
  },
  {
    subject: 'did you see the Stripe posting',
    body: [
      'The Stripe intern posting just went up on Handshake and it closes in two weeks. We should do a mock interview swap before then — are you free Tuesday?',
      "I can do Tuesday after 4 or Wednesday morning. Let's do one behavioral and one medium problem each, and actually time them this round instead of chatting through the answers."
    ]
  },
  {
    subject: "Re: Notes from today's discussion",
    body: [
      'These are so good, thank you!! The tie-breaking part finally clicked. Trade you for my CDSS notes — also did you start the project yet or are we both doomed?',
      "I have not started the project. The spec says it's two weeks of work. We have nine days. It's fine. Everything is fine.",
      'CDSS notes are in the same shared folder — the sampling diagrams actually came out legible this time.'
    ]
  },
  {
    subject: 'intro to my friend at KCL',
    body: [
      "Devah — meet Priya, she's a second-year at King's and lived in Stamford Street last year. Priya, Devah's headed to KCL in the spring and has housing questions.",
      'Priya did the whole Zone 1 versus Zone 2 math last year so you don\'t have to, and she knows which modules are secretly great. She\'s also just fun — you two will get along.',
      "I'll let you two take it from here!"
    ]
  }
]

const MOM = makeSender('Mom', 'linda.schaefers@comcast.net')

const MOM_MESSAGES: MsgTemplate[] = [
  {
    subject: 'checking in',
    body: [
      "Hi sweetheart, Dad and I were talking about your London plans last night. Have you heard back about housing yet? Grandma wants to know if you'll be home for Thanksgiving before you go.",
      'Also your cousin Emma got into Michigan, so expect a call from Aunt Carol about it. Act surprised.',
      'Eat something green this week. Love, Mom'
    ]
  },
  {
    subject: 'Fwd: Your flight confirmation',
    body: [
      'Forwarding this so you have a copy too. Dad says to book the airport shuttle early. Also call your grandmother, she asked about you twice this week.',
      'Do you need us to bring anything up when we visit before you leave? Dad found your old rain jacket in the garage and insists London requires it.',
      'Love, Mom'
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

function inviteBody(ev: InviteEvent, day: string, organizer: Sender): string[] {
  const when = `${day}, ${fmtHour(ev.start)} - ${fmtHour(ev.end)} Pacific Time`
  switch (ev.kind) {
    case 'Invitation':
      return [
        `You have been invited to the following event. When: ${when}. Where: ${ev.where}. Organizer: ${organizer.name}. Join with Google Meet.`,
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
        `${organizer.name} has accepted this invitation. ${ev.title}, ${when}. Where: ${ev.where}.`,
        'This response has been recorded on your calendar. Current attendance: 2 yes, 0 no, 0 awaiting reply. No further action is needed.'
      ]
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

const categoryDeck: Category[] = faker.helpers.shuffle([
  ...(Array(108).fill('notifications') as Category[]),
  ...(Array(45).fill('people') as Category[]),
  ...(Array(27).fill('invites') as Category[])
])

// Sent, drafts, and spam are hand-written below; the generated stream is inbox plus trash.
const folderDeck: Folder[] = faker.helpers.shuffle([
  ...(Array(172).fill('inbox') as Folder[]),
  ...(Array(8).fill('trash') as Folder[])
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
  body: string[]
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
    let body: string[]
    let accountId: string

    if (category === 'notifications') {
      const { src, msg } = notifDeck[notifIdx++]
      sender = src.sender
      subject = msg.subject
      body = msg.body
      accountId = src.accountId
    } else if (category === 'people') {
      if (peopleIdx === 4 || peopleIdx === 22) {
        const msg = MOM_MESSAGES[peopleIdx === 4 ? 0 : 1]
        sender = MOM
        subject = msg.subject
        body = msg.body
        accountId = 'gmail'
      } else {
        const msg = peopleDeck[peopleIdx]
        sender = faker.helpers.arrayElement(peoplePool)
        subject = msg.subject
        body = msg.body
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
      body = inviteBody(ev, day, organizer)
      accountId = ev.fromUceap ? 'berkeley' : pickAccount()
    }

    const ageMinutes = (NOW - ms) / MINUTE
    const read = ageMinutes <= 120 ? false : faker.datatype.boolean(0.72)

    drafts.push({
      ms,
      dayIndex,
      accountId,
      sender,
      subject,
      body,
      category,
      read,
      important: false,
      pinned: false,
      folder
    })
    slot++
  }
}

// ---------------------------------------------------------------------------
// Sent, drafts, and spam: hand-written, appended outside the generated stream.
// For sent and draft mail, `sender` is the RECIPIENT (what the list shows).
// ---------------------------------------------------------------------------

const PRIYA = makeSender('Priya Raghavan', 'priya.raghavan@kcl.ac.uk')

function pickPerson(): Sender {
  return faker.helpers.arrayElement(peoplePool)
}

interface ExtraMail {
  sender: Sender
  accountId: string
  subject: string
  body: string[]
  /** Fractional days before NOW; minute-level jitter is added on top */
  daysAgo: number
  category: Category
  read: boolean
}

const SENT_MAIL: ExtraMail[] = [
  {
    sender: pickPerson(),
    accountId: 'berkeley',
    subject: 'Re: study group this weekend',
    body: [
      "Saturday at 2 works — see you on the Moffitt 4th floor. The room is under your name, right? I'll bring my HW3 attempt: parts (a) and (b) are done, plus a graveyard of failed ideas for (c).",
      "Can we also spend 20 minutes on the exchange argument before we start? I think I finally get the tie-breaking case, and explaining it out loud will tell me whether that's actually true.",
      'Devah'
    ],
    daysAgo: 0.6,
    category: 'people',
    read: true
  },
  {
    sender: MOM,
    accountId: 'gmail',
    subject: 'Re: checking in',
    body: [
      "Hi Mom, good news — housing came through this morning. I got a spot at Stamford Street, the one eight minutes from campus. It's an ensuite, so you can officially stop worrying about the shared bathroom thing.",
      "Yes to Thanksgiving — I land the Tuesday before. And I'll call Grandma this Sunday, I promise. Tell her to take her phone off silent this time.",
      'Love, Devah'
    ],
    daysAgo: 1.2,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'berkeley',
    subject: "Re: Notes from today's discussion",
    body: [
      'You are genuinely a lifesaver — the slide 14 writeup is clearer than the actual lecture. I added my solutions for the practice problems at the bottom of the doc in a different color.',
      'Trade accepted on the CDSS notes. And no, I have not started the project either. Nine days is basically two weeks if you round up.',
      'Devah'
    ],
    daysAgo: 2.1,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'berkeley',
    subject: 'Re: recommendation letter',
    body: [
      "Thank you so much — this means a lot. I've attached my resume, unofficial transcript, and a paragraph about the KCL program and why I'm applying.",
      "The assignments I'm proudest of from your course are the scheduling problem on HW2 and my final project on approximation algorithms. Happy to send either writeup if it would help.",
      'The deadline is October 15 through the UCEAP portal — it should email you a submission link directly. Thanks again, Devah'
    ],
    daysAgo: 3,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'gmail',
    subject: 'Re: flight to Heathrow',
    body: [
      'Booked! Nonstop on the 8th, seat 34A, $612 exactly as promised. Send me your confirmation number and I\'ll see about getting us seats together — worst case we bribe whoever has 34B.',
      'Agreed on skipping the Heathrow Express; the Piccadilly line goes straight to my halls anyway. First pub lunch is on me if you handle the Oyster card logistics.',
      'Devah'
    ],
    daysAgo: 3.8,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'berkeley',
    subject: 'Re: you left your charger in Soda',
    body: [
      "That's mine, thank you!! I spent twenty minutes this morning convinced I'd left it at V&A. I'll swing by the Woz around 4:30 — if you've left by then, just leave it with whoever's at the front desk.",
      'I owe you a coffee. Devah'
    ],
    daysAgo: 4.5,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'icloud',
    subject: 'Re: Spring sublease?',
    body: [
      "Yes — I'm subleasing January through May and your friend's timing is basically perfect. $1,100 plus utilities works, and the cat is fine as long as she covers anything the cat destroys.",
      "I'm putting together a short listing with photos this week. I'll send it to you first so she gets first shot before I post it anywhere.",
      'Devah'
    ],
    daysAgo: 5.5,
    category: 'people',
    read: true
  },
  {
    sender: PRIYA,
    accountId: 'berkeley',
    subject: 'Re: intro to my friend at KCL',
    body: [
      "Hi Priya, so nice to e-meet you! I just got placed at Stamford Street, which I hear is where you lived — I am very open to a brain dump on anything from laundry logistics to which modules are secretly great.",
      "No rush at all, but if you're up for a call sometime in the next few weeks I'd love that. Whatever time works with the time difference — my schedule is flexible after 9 AM Pacific.",
      'Thanks for being up for the intro. Devah'
    ],
    daysAgo: 6.5,
    category: 'people',
    read: true
  },
  {
    sender: NOTIF_SOURCES[0].sender,
    accountId: 'berkeley',
    subject: 'Question about my transcript upload',
    body: [
      "Hi, I submitted my Acknowledgement of Nomination last week, but my portal checklist still shows the transcript item as 'in review' after ten days. The confirmation email said reviews take two business days.",
      'Could you confirm it was received? I want to make sure nothing is holding up my file before the KCL deadline. My student ID is 3036841772.',
      'Thank you, Devah Schaefers'
    ],
    daysAgo: 7.2,
    category: 'notifications',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'berkeley',
    subject: 'Re: did you see the Stripe posting',
    body: [
      "Tuesday after 4 works. Let's do the full loop: one behavioral, one medium each, actually timed, and no 'wait, let me just finish this thought' at the 35-minute mark. (That one's directed at me, not you.)",
      "I grabbed a Cory breakout room for 4:15. Bring your question list from last time and I'll bring two new ones from the tagged list.",
      'Devah'
    ],
    daysAgo: 8.4,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'gmail',
    subject: 'Re: Dinner Friday?',
    body: [
      "Yes, obviously. I'll be there at 7 sharp, I'm getting the drunken noodles, and you cannot stop me.",
      "Also, 'before you disappear to London forever' — it's five months. I'll be back before the good weather. Save the guilt trip for my mom, she's better at it.",
      'Devah'
    ],
    daysAgo: 9.3,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'berkeley',
    subject: 'Re: Quick question about the CDSS lab',
    body: [
      "Mine came out to (0.44, 0.57), so yours isn't crazy. I dropped the null rows before splitting — the lab spec buries that in a footnote under the second code cell.",
      "If it still looks off after that, check that you're resampling with replacement. That one cost me an hour.",
      'Devah'
    ],
    daysAgo: 10.5,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'gmail',
    subject: 'sublease listing — read this before I post?',
    body: [
      "Can you sanity-check this before I put it up? 'Sunny room in 3BR near North Berkeley BART, Jan-May, $1,100/mo + utilities, furnished, quiet housemates, no smoking.' Does 'quiet housemates' sound like a threat?",
      'Also: do I mention the kitchen situation, or let them discover the ant thing organically? Kidding. Mostly.',
      'Devah'
    ],
    daysAgo: 11.4,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'berkeley',
    subject: 'Re: Midterm review sesh Sunday',
    body: [
      "I'm in for Sunday. I added my solutions to the shared doc tonight — flagged two where I got a different answer from the doc, which should be fun to argue about in person.",
      'Can someone bring a whiteboard marker that actually works? The ones in Moffitt have been dead since 2024.',
      'Devah'
    ],
    daysAgo: 12.5,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'gmail',
    subject: 'Re: photos from Tahoe',
    body: [
      'These are unreal — the ridge sunrise one is going straight into a frame. Can you send me the full-res of that one and the lake panorama?',
      'I am aware of the sneeze photo. Name your price for its deletion.',
      'Devah'
    ],
    daysAgo: 13.4,
    category: 'people',
    read: true
  }
]

const DRAFT_MAIL: ExtraMail[] = [
  {
    sender: MOM,
    accountId: 'gmail',
    subject: 'thanksgiving flights',
    body: [
      "Hi Mom, Looking at flights home for Thanksgiving — the Tuesday night one gets in at 11:40pm, the Wednesday morning one is $120 more but I'd actually be awake for dinner prep.",
      'Also thinking about what to do with my plants while I\'m in London. Options are (a) you inherit them, (b)'
    ],
    daysAgo: 0.3,
    category: 'people',
    read: true
  },
  {
    sender: NOTIF_SOURCES[0].sender,
    accountId: 'berkeley',
    subject: 'Re: Pre-Departure Checklist: 45 days to go',
    body: [
      "Hi, Quick question about the insurance requirement — I'm currently on SHIP through campus. Does that satisfy the UCEAP coverage minimums for the UK, or do I need the supplemental plan regardless? The checklist wording"
    ],
    daysAgo: 1.5,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'berkeley',
    subject: 'project partner?',
    body: [
      "Hey — are you doing the CDSS project with anyone yet? I'm dangerously close to just doing it solo, but the spec says groups of two get access to the bigger dataset and",
      '(also fair warning, I will be in London for the last two weeks of it, but the deliverables are all remote-friendly)'
    ],
    daysAgo: 2.4,
    category: 'people',
    read: true
  },
  {
    sender: pickPerson(),
    accountId: 'gmail',
    subject: 'packing list — what did you actually use?',
    body: [
      'Making my London packing list and realizing I own three jackets that all do the same thing. You studied abroad — what did you actually use vs. haul around for five months?',
      'Current list: laptop, two universal adapters (learned from your mistake), rain shell, one nice outfit for whatever formal dinner situation may arise, and'
    ],
    daysAgo: 4.1,
    category: 'people',
    read: true
  }
]

const SPAM_MAIL: ExtraMail[] = [
  {
    sender: makeSender('USPS Parcel Alert', 'delivery@usps-parcel-alerts.info'),
    accountId: 'gmail',
    subject: 'Your package could not be delivered — schedule redelivery now',
    body: [
      'Dear Customer, We attempted to deliver your package today but were unable to complete the delivery because of an incomplete address. Your parcel USPS-9400-1102-8845 is being held at our facility.',
      'To schedule redelivery, please confirm your address and pay the $1.95 redelivery fee within 24 hours or your package will be returned to sender.',
      'This is the final notice. Click here to confirm your details now.'
    ],
    daysAgo: 0.8,
    category: 'notifications',
    read: false
  },
  {
    sender: makeSender('Coinbase Rewards', 'promo@coinbase-rewardz.win'),
    accountId: 'gmail',
    subject: 'You have unclaimed Bitcoin worth $312.44',
    body: [
      'Congratulations! Our records show a pending BTC reward of $312.44 linked to this email address from our 2025 loyalty program. Rewards not claimed within 48 hours are forfeited.',
      'Verify your wallet now to release the funds. This offer cannot be extended.'
    ],
    daysAgo: 2.4,
    category: 'notifications',
    read: false
  },
  {
    sender: makeSender('Netflix Billing', 'account-verify@netfliix-support.com'),
    accountId: 'icloud',
    subject: 'Your account is on hold — update your payment information',
    body: [
      'Dear Valued Customer, We were unable to process your last payment. To avoid interruption of service, please update your billing information within 48 hours.',
      'If we do not receive updated payment details, your membership and viewing history will be permanently deleted. Update now to keep watching.'
    ],
    daysAgo: 4.6,
    category: 'notifications',
    read: true
  },
  {
    sender: makeSender('Vehicle Warranty Dept', 'noreply@auto-warranty-final.org'),
    accountId: 'icloud',
    subject: "FINAL NOTICE: your vehicle's extended warranty",
    body: [
      "We have been trying to reach you concerning your vehicle's extended warranty. Your factory coverage has expired or is about to expire, and you are still eligible for renewal at a reduced rate.",
      'This is your final courtesy notice before your file is closed permanently. Reply now to speak with a coverage specialist today.'
    ],
    daysAgo: 7.5,
    category: 'notifications',
    read: false
  },
  {
    sender: makeSender('Prize Notification Dept', 'claims@intl-lottery-notice.net'),
    accountId: 'gmail',
    subject: 'CONGRATULATIONS: your email address has WON $2,500,000.00',
    body: [
      'Dear Lucky Winner, Your email address was selected in the International Email Lottery Programme held on 15th August. You have won the sum of $2,500,000.00 (Two Million Five Hundred Thousand Dollars).',
      'To begin your claim, send your full name, address, phone number, and a copy of a valid ID to our claims agent. Note: keep this notification confidential to avoid double claims.'
    ],
    daysAgo: 11,
    category: 'notifications',
    read: true
  },
  {
    sender: makeSender('Barrister Emmanuel Okon', 'emmanuel.okon.esq@lagos-chambers-mail.com'),
    accountId: 'berkeley',
    subject: 'URGENT BUSINESS PROPOSAL (CONFIDENTIAL)',
    body: [
      'Dear Friend, I am Barrister Emmanuel Okon, personal attorney to a late client who shares your surname. He left behind the sum of USD $8.4M in a dormant account with no next of kin.',
      'I propose to present you as the beneficiary. For your cooperation you will receive 40% of the total sum. This transaction is 100% risk free and legal.',
      'Kindly reply with your direct telephone number for more details. Time is of the essence.'
    ],
    daysAgo: 13.8,
    category: 'notifications',
    read: false
  }
]

function pushExtras(list: ExtraMail[], folder: Folder): void {
  for (const m of list) {
    const ms = NOW - Math.round(m.daysAgo * DAY) - faker.number.int({ min: 0, max: 150 }) * MINUTE
    drafts.push({
      ms,
      dayIndex: Math.floor((NOW - ms) / DAY),
      accountId: m.accountId,
      sender: m.sender,
      subject: m.subject,
      body: m.body,
      category: m.category,
      read: m.read,
      important: false,
      pinned: false,
      folder
    })
  }
}

pushExtras(SENT_MAIL, 'sent')
pushExtras(DRAFT_MAIL, 'drafts')
pushExtras(SPAM_MAIL, 'spam')

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

export const emails: Email[] = drafts.map((d, i) => ({
  id: `email-${String(i + 1).padStart(3, '0')}`,
  accountId: d.accountId,
  sender: d.sender,
  subject: d.subject,
  preview: previewOf(d.body),
  body: d.body,
  date: new Date(d.ms).toISOString(),
  category: d.category,
  read: d.read,
  important: d.important,
  pinned: d.pinned,
  folder: d.folder
}))
