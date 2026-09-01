# Getting started with Attend

This guide is for the person installing Attend, not for the coding agent that runs it. It covers what Attend is for, what installing it costs you, what your first session looks like, and which questions are worth asking it. The last two sections are the honest ones. They say what Attend will not do yet and what silence from it means.

## What Attend is for

You already have a private record. Notes, journal entries, meeting write-ups, research files, a vault with folders and templates you built over years. You probably already have a coding agent attached to it that does some maintenance for you.

That record is organized. Being organized is not the same as being legible. A folder tree can tell you where something lives. It cannot tell you why a position changed, what else was happening when an idea became important, which old note bears on a decision you are making now, or whether the things you say matter are the things you actually spend time on.

Attend is a local instrument for those questions. Your agent reads the files you authorize, builds a visualization from them, and opens it in a private workspace on your own machine. Every mark on the chart is backed by exact quotes from your own files. Click one and you get the underlying entries as a list. Ask about it and a model running on your laptop answers from those entries.

It is deliberately not several things. It is not a place to put your files. It is not a project dashboard, because your project tool already does that job. It is not a search box, because search only answers the question you remembered to ask. It is not a chart gallery. If a proposed view is mostly a folder tree in a different shape, Attend should not build it, and the skill that governs it is written to refuse.

The narrow claim is this. Some questions about your own record deserve a visual answer with the evidence still attached, and Attend gives your agent a reliable way to produce one.

## Before you install

Attend runs on macOS or Linux. You need Node.js 22 or newer, npm, and llama.cpp's `llama-server`. On macOS, `brew install llama.cpp` covers the last one.

The private model is roughly 12 GB on disk. A machine with 24 GB of memory or more is recommended. The download is the slowest part of setup and it happens once.

Attend reads the files you point it at. It does not edit them, does not watch them, and does not scan paths you did not supply. Nothing is uploaded. There is no Attend account, no hosted service, and no telemetry. The default chat runs `gpt-oss-20b` as a subprocess on your machine in offline mode, with no provider credentials, no project path, and no tools. The page server and the model endpoint are both loopback only.

Setup writes five files into the repository and nothing else. `.attend/project.json` is shared configuration and is safe to commit. `.attend/.gitignore` keeps everything under `.attend/local/` out of version control, which is where your derived packages, private evidence, sessions, and conversations stay. The remaining three are the instruction file that teaches your agent how to use Attend, installed once for Codex under `.agents/skills/` and once for Claude under `.claude/skills/`. Setup starts no background process and can be run again safely.

## Install

Open the repository holding the notes you want to work with. Paste this into your coding agent.

```text
Install Attend and set it up for this repository.

You may install Attend globally, add its setup files to this repository, install llama.cpp with Homebrew if needed, and download the roughly 12 GB local model. Stay in this repository. Do not upload its files or use sudo.

Attend needs macOS or Linux, Node.js 22 or newer, and npm. If anything is missing, stop and tell me. On macOS, if `llama-server` is missing and Homebrew is available, run `brew install llama.cpp`.

Run `npm install --global @siunami/attend`. If npm cannot install globally without sudo, install Attend under my user account instead. Then run `attend bootstrap --yes` and show me the output. You may retry it after an interrupted download. Drive the setup yourself; I'll only step in for a macOS approval.

Keep any existing Attend chat choice. For a new setup, use Attend's private local chat. Do not sign in to Codex or Claude for Attend. If installation or setup fails, show me the actual error. When Attend is ready, show me its welcome and installed version.
```

`attend bootstrap --yes` owns the whole setup. It configures the repository, installs the model when needed, and verifies that the installed files and the chat route are healthy. It is safe to run again after an interrupted download.

If you would rather do it yourself, the terminal path is in the [README](../README.md#install-from-a-terminal).

Two things to expect. The model download takes a while and looks like nothing is happening. And Attend accepts `.md`, `.mdx`, `.txt`, and normalized `.jsonl` sources. If your record is a Markdown vault, you are already in the supported case. PDFs, spreadsheets, and web clippings are not readable yet.

## Your first session

You do not run Attend. You talk to your agent the way you already do, and Attend is the thing your agent reaches for when a visual answer beats a paragraph.

Ask your agent something concrete about your own files. A good first question names a folder and a span of time.

> Look at my daily notes from the last three months and show me what I actually spent my writing on.

Here is what happens behind that. Your agent asks Attend for its catalog of governed forms, picks one executable form that fits the analytic job, and reads your notes. It turns what it found into a data-only request where every value carries an exact quote from a real file. Attend reopens those files itself, verifies every quote, refuses anything it cannot ground, compiles the result into a sealed package, and serves it on loopback. Your agent hands you a link.

Open the link. You get a chart, and under it, the data.

Click a mark. The list below the chart filters to exactly the entries behind that mark, and the mark attaches itself to the chat composer. It does not open the chat drawer or interrupt you. When you want to talk about what you selected, press the Ask button or `Cmd`+`/`, type your question, and the local model answers from those entries and quotes them back.

That is the loop. Look, click, read the actual notes, ask. The chart is the index. Your writing is the answer.

## A first week

**Day one, twenty minutes.** Install, then ask one question you already know the answer to. Something like which topics recur across your last three months of notes. You are not learning anything yet. You are checking whether the marks point at the right files and whether the chat quotes you accurately. If it gets something wrong here, say so now. The whole system is built so a wrong mark can be traced back to the exact quote that produced it.

**Day two, ten minutes.** Ask a question you genuinely do not know the answer to, about a subject you have been writing about for months. Click the point where the line moves. Read what you wrote that week. This is the first moment Attend can do something search cannot, because you did not have to remember which note to look for.

**Day four.** Ask your agent an ordinary working question, one with nothing visual about it. Somewhere in that work Attend may quietly offer a view of what it found. It may also say nothing at all, which is the more common and more correct outcome. Notice which one happened and whether you agreed with it.

**Week two.** Go back to a visualization you made in week one. If your notes changed, ask your agent to regenerate it from the same request and compare. The question you keep re-asking is the one worth keeping.

**Week four.** The real test. Did you open one of these on your own, without being prompted, because you wanted the answer? Attend earns its place there or it does not earn it at all. Admiring a chart does not count.

## Questions worth asking it

Each of these is reachable today with the forms Attend ships. The form name in parentheses is what your agent will reach for; you never have to name it yourself.

**What was I working on when this changed?** Ask for your notes over time on one subject, then click the inflection point. (`trend/line`, then the filtered list.) This is the strongest thing Attend does right now. The chart is an index into a week of your own writing that you would not have gone looking for.

**What have I actually been writing about?** Ask for the topics or entities that recur across a folder and a date range. (`rank/bar-list`.) Clicking any bar gives you every entry behind it. Useful for the gap between what you think your last quarter was about and what it was about.

**When do I do my thinking?** Ask for note or meeting volume by weekday and hour. (`matrix/heatmap`.) Small, quick, and often uncomfortable.

**What was happening around this decision?** Ask for everything in a date window as a sequence of events. (`timeline/event-strip` or `timeline/interval`.) Good before you revisit a decision, because it reconstructs the surrounding week instead of just the note that recorded the choice.

**Do my stated priorities match where my attention went?** This one takes two inputs. Point your agent at the note where you wrote down your priorities and at the record of what you actually wrote. Ask it to compare them. (`rank/dot-plot` or `rank/slopegraph`.) Attend will show you the divergence. It will not tell you what it means, which is the correct division of labor.

**Which of these keep coming back?** For a research vault with repeated subjects, ask which ones recur across the most distinct sources rather than the most times. (`rank/bar-list` again, or `distribution/histogram` for the shape.) Breadth across sources is a better signal of a live interest than raw repetition inside one long note.

**How do these connect?** Ask for the subjects that co-occur across your notes. (`network/local`.) Use this one sparingly. It is the most seductive view and the easiest to over-read.

**How did these two positions differ?** For two versions of the same document or two write-ups of the same subject, ask for them side by side. (`passage-comparison/parallel-text`.) The evidence is the text itself, aligned.

There is also a shortcut that skips the agent entirely, for the simplest case:

```sh
attend phrases notes/ --question "Which phrases recur across these notes?" --json
attend view --open --json
```

## Reading what you get

**Marks are the unit.** Every dot, bar, cell, and node is a mark, and every mark traces to exact quotes in files you authorized. There is no summarized or generated value anywhere on the chart that is not backed that way.

**Clicking filters, it does not navigate.** Under every chart is a Data panel listing the rows behind it, with their values and how much evidence each one carries. Click a mark and that list narrows to exactly the records the mark stands for. Click the same mark again, or press Show all, to widen back out. You can click a row instead of a mark and get the same result. Long lists show the first hundred rows and tell you the real total.

**Nothing happens on hover.** Hovering never reveals a panel and never changes the height of the page, so a small target cannot flicker out from under your cursor.

**Chat is opt-in.** Your selection attaches to the composer as soon as you click. Nothing is sent until you actually ask something.

**Aggregates are recomputed, not trusted.** When you select something that stands for many records, the browser sends only its identifier and the server recomputes the membership and verifies the count. Chat gets a bounded preview and is told explicitly how many items were left out.

**Two views of your own history.** The workspace has a gallery view, which shows finished visualizations with a one-line reason and a small relevance score, and a debug view, which shows every attempt including the failures. The gallery is the one for ordinary use. The debug view exists because Attend keeps every experiment it admitted, including the boring and broken ones, so that its record of what it tried is honest.

## What Attend will not do yet

This matters more than the feature list. The version you are installing is early and its ambitions are further along than its build.

**It will not tell you anything unless you ask.** There is no scheduler, no watcher, and no notification. Attend never opens itself, never runs overnight, and cannot bring something back to your attention on its own. Passive resurfacing is the feature this whole project is pointed at, and it does not exist yet. Today, someone still has to start the conversation, and that someone is you.

**It reads text only.** `.md`, `.mdx`, `.txt`, and normalized `.jsonl`. A folder of JPEGs works for one specific form. PDFs, CSVs, spreadsheets, audio, and video do not.

**It has no memory across sessions.** Attend does not build a model of you, does not learn your preferences, and does not carry anything between projects. Each question stands alone.

**It cannot state your current position.** It can show you a trajectory and open the evidence along it. It cannot yet say "here is where you landed and what is still unresolved" as a maintained synthesis.

**It has 34 built forms out of 106 it recognizes.** When your question needs one of the other 72, Attend refuses and hands the work back to your agent rather than substituting a chart that looks close. Annotated image specimens in particular are unavailable until Attend can verify region coordinates properly. A refusal is the system working.

**Chat is small and local.** `gpt-oss-20b` on your machine is private and it is not frontier-class. It answers well from evidence placed in front of it and poorly when asked for something it was not given.

## When Attend says nothing

During ordinary work, your agent reaches a natural boundary and asks itself one question. Is there bounded evidence here that plausibly contains a comparison, a distribution, a change, a relationship, a hierarchy, a network, a location, or a sequence, and is that worth interrupting you for? Most of the time the answer is no, and Attend records that it considered and declined, then stays completely silent. No message, no chart, no artifact.

That silence is the feature under test. A tool that offered a visualization every time it could would be noise within a week. If Attend interrupts you when it should not have, that is a bug worth reporting, and so is the reverse.

## What would be useful to hear back

If you are trying this as a favor to whoever handed it to you, these are the things worth writing down.

Did you open one of these again a week later, on your own, because you wanted the answer? That is the only question that really matters.

Was there a moment where a mark opened something you had genuinely forgotten? What was it, and would you have found it another way?

Did the chat ever say something your notes do not support? That is the most serious kind of failure here, so if it happens, keep the artifact.

When Attend offered something unprompted, was it worth the interruption? When it stayed quiet through work where a view would have helped, what was the work?

And what did it cost you? Setup time, disk, attention, the maintenance of pointing it at the right folders. If keeping the instrument costs more than it returns, that is the finding.

## If something breaks

```sh
attend doctor --json
```

That reports core readiness, the local model, and the selected chat route separately, so you can tell a model problem from a setup problem. `attend status` reports the service and its URLs. `attend stop` stops the background service without deleting any artifact or configuration.

Attend never edits your source files, so nothing you do here can damage the record. The worst case is a bad visualization, and you can delete `.attend/local/` and start over.
