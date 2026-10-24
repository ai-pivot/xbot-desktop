import { useState } from "react";
import { Check } from "lucide-react";
import type { AskUserUi } from "../types";

export function AskUserPanel({
  prompt,
  onSubmit,
  onLater,
}: {
  prompt: AskUserUi;
  onSubmit: (answers: Record<string, string>) => Promise<void>;
  onLater: () => void;
}) {
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const toggle = (index: number, option: string, multi: boolean) => {
    setSelected((current) => {
      const values = current[index] ?? [];
      const next = multi
        ? values.includes(option)
          ? values.filter((value) => value !== option)
          : [...values, option]
        : [option];
      return { ...current, [index]: next };
    });
  };

  const submit = () => {
    const answers: Record<string, string> = {};
    prompt.questions.forEach((question, index) => {
      const free = other[index]?.trim();
      if (free) answers[String(index + 1)] = free;
      else if (selected[index]?.length) answers[String(index + 1)] = selected[index].join("、");
    });
    void onSubmit(answers);
  };

  return (
    <div className="ask-user">
      <div className="ask-title">
        <Check size={15} />
        Agent 需要你的回答
      </div>
      {prompt.questions.map((question, index) => (
        <div className="ask-question" key={index}>
          <div className="ask-question-text">{question.question}</div>
          {question.options.length > 0 && (
            <div className="ask-options">
              {question.options.map((option) => {
                const active = (selected[index] ?? []).includes(option);
                return (
                  <button
                    key={option}
                    className={`ask-option ${active ? "active" : ""}`}
                    onClick={() => toggle(index, option, question.multi_select)}
                  >
                    <span className="ask-radio">{active ? "●" : "○"}</span>
                    {option}
                  </button>
                );
              })}
            </div>
          )}
          {(question.allow_other || question.options.length === 0) && (
            <input
              className="input"
              placeholder="其他 / 直接回答"
              value={other[index] ?? ""}
              onChange={(event) => setOther((current) => ({ ...current, [index]: event.target.value }))}
            />
          )}
        </div>
      ))}
      <div className="ask-actions">
        <button className="button primary" onClick={submit}>
          提交
        </button>
        <button className="button ghost" onClick={onLater}>
          稍后
        </button>
      </div>
    </div>
  );
}
