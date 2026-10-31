import { useForm, useStore } from "@tanstack/react-form";
import type { TaskRequest } from "../../../src/contracts/index.js";
import type { TaskStream } from "../../app/use-workflow-data.js";
import { describeActivity } from "../execution/activity.js";
import Icon from "../../shared/Icon.js";
import ActivityFeed from "../execution/ActivityFeed.js";
import { useAutosize } from "../../shared/autosize.js";

type TaskPlanningProps = {
  task: TaskRequest;
  stream?: TaskStream;
  busy: boolean;
  onAnswer: (answer: string) => void;
  onCancel: () => void;
  onRetry: () => void;
};

const stages = [
  "Read the request & attachments",
  "Match project task instructions",
  "Compose blocks, models & handoffs",
  "Validate the workflow",
];

function Clarification({
  question,
  busy,
  onAnswer,
}: {
  question: NonNullable<TaskRequest["question"]>;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const form = useForm({
    defaultValues: { answer: "" },
    onSubmit: ({ value }) => {
      if (!busy && value.answer.trim()) onAnswer(value.answer);
    },
  });
  const answer = useStore(form.store, (state) => state.values.answer);
  const answerRef = useAutosize(answer);
  return (
    <form
      className="clarification-card"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <label htmlFor="task-answer">{question.question}</label>
      <div className="answer-options">
        {question.options.map((option) => (
          <button
            key={option}
            type="button"
            className={answer === option ? "selected" : undefined}
            onClick={() => form.setFieldValue("answer", option)}
          >
            {option}
          </button>
        ))}
      </div>
      <form.Field name="answer">
        {(field) => (
          <textarea
            id="task-answer"
            name={field.name}
            ref={answerRef}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.currentTarget.value)}
            onBlur={field.handleBlur}
            rows={3}
            disabled={busy}
            placeholder="Your answer…"
          />
        )}
      </form.Field>
      <button className="primary" disabled={busy || !answer.trim()}>
        Continue planning
        <Icon name="arrow" size={16} />
      </button>
    </form>
  );
}

export default function TaskPlanning({
  task,
  stream,
  busy,
  onAnswer,
  onCancel,
  onRetry,
}: TaskPlanningProps) {
  const failed = ["failed", "cancelled"].includes(task.status);
  const stage = task.events.some((event) => event.kind === "plan_ready")
    ? 3
    : task.events.some((event) => event.kind === "classification")
      ? 2
      : task.status === "planning"
        ? 1
        : 0;
  const lastEvent = task.events.at(-1);

  return (
    <div className="planning-panel">
      <div className="planning-title">
        <div className={failed ? "planning-symbol" : "working-orb"}>
          <Icon name={task.status === "needs_input" ? "file" : "spark"} size={26} />
        </div>
        <h1>
          {task.status === "queued"
            ? "Your task is queued"
            : task.status === "needs_input"
              ? "One detail before we start"
              : failed
                ? "Planning stopped"
                : "Building your workflow"}
        </h1>
        <p>
          {task.status === "needs_input"
            ? "The coordinator needs this answer to make a useful plan."
            : failed
              ? task.error
              : "Understanding the request, choosing the right blocks, and connecting the steps."}
        </p>
      </div>
      {task.status === "needs_input" && task.question ? (
        <Clarification
          key={task.question.question}
          question={task.question}
          busy={busy}
          onAnswer={onAnswer}
        />
      ) : !failed ? (
        <div className="planning-stages">
          {stages.map((label, index) => (
            <div
              key={label}
              className={index < stage ? "done" : index === stage ? "current" : undefined}
            >
              <span>
                {index < stage ? (
                  <Icon name="check" size={14} />
                ) : index === stage ? (
                  <span className="spinner" />
                ) : (
                  index + 1
                )}
              </span>
              {label}
            </div>
          ))}
        </div>
      ) : null}
      {!failed && task.status !== "needs_input" && (
        <div className="planning-live" role="status">
          <span className="live-dot" />
          <span>
            {stream?.activity && !["queued", "planning"].includes(stream.activity)
              ? stream.activity.slice(0, 220)
              : lastEvent
                ? describeActivity(lastEvent).preview
                : "Waiting for the coordinator…"}
          </span>
        </div>
      )}
      {!!(task.events.length || stream?.text) && (
        <details className="planning-logs">
          <summary>
            <Icon name="log" size={15} />
            Planning activity
          </summary>
          <ActivityFeed
            key={task.id}
            events={task.events}
            liveText={stream?.text}
            running={["queued", "planning"].includes(task.status)}
            title="Planning activity"
          />
        </details>
      )}
      <div className="planning-actions">
        {failed ? (
          <button className="primary" disabled={busy} onClick={onRetry}>
            Retry planning
          </button>
        ) : (
          <button className="quiet" disabled={busy} onClick={onCancel}>
            Cancel planning
          </button>
        )}
      </div>
    </div>
  );
}
