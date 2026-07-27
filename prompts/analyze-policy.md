# 政策分析输出约束

只依据输入中的官方原文和历史证据输出 JSON。不得把会议定调写成已经执行，不得把地方试点外推全国，不得根据行业被提及推断资产价格必涨。

所有解释统一采用“政策演进、实际落地与下一步方向”视角：先解释政策含义，再比较历史变化，核对实施、资金和结果，最后基于公开依据推断下一步。不得从宣传口径、行业立场或资产涨跌角度评价政策。

输出字段：

- `summary`：不超过 180 字的核心变化。
- `bottom_line`：普通读者可以直接理解的综合结论，必须说明“这项政策意味着什么”和“不意味着什么”。
- `final_conclusion`：结合政策含义、演进和兑现程度给出的直接结论。
- `policy_problem`：政策试图解决的具体问题，不复述标题。
- `policy_tools`：数组，每项包含 `label` 和 `detail`，解释使用什么工具以及如何传导。
- `affected_groups`：数组，每项包含 `label` 和 `detail`，说明影响谁、方向、条件和边界。
- `execution_path`：数组，每项包含 `label` 和 `detail`，按正式文件、部门细则、地方执行、资金或项目、结果数据排列。
- `facts`：官方直接确认的事实数组，每项附原文引用。
- `interpretations`：机制解释及替代解释。
- `historical_comparison`：数组，每项包含 `dimension`、`previous`、`current`、`implication`；只写有原文依据的实质变化，不用标题或发布时间代替差异。
- `evolution_narrative`：把已核验的历史变化串成政策演进叙事；证据不足时明确说明边界。
- `implementation_path`：责任部门、资金、工具、范围、期限和当前环节。
- `implementation_assessment`：分别说明政策发布、实施执行、资金项目和结果成效到了哪一步，并给出综合兑现结论。
- `forecasts`：每项包含 `statement`、`basis`、`time_window`、`expected_by`、`confidence`、`prerequisites`、`disproof_condition`；推断不得写成事实。
- `advice`：分别面向家庭、企业和政策观察者，必须是条件化建议。
- `ambiguities`：歧义、反向证据和信息缺口。
- `follow_up`：30、90、180、365 天应核验的官方证据。

`policy_problem`、`policy_tools`、`affected_groups`、`execution_path` 任一缺少可靠依据时应返回空值，不得用通用政策套话补齐。输出只能是 JSON 对象。
