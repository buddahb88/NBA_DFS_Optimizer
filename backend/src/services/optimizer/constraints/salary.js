/**
 * SALARY
 * Total salary between ctx.minSalary and the site's salary cap.
 */
export const name = 'salary';

export function apply(model, ctx) {
  model.constraints.salary = { max: ctx.site.salaryCap };
  model.constraints.minSalary = { min: ctx.minSalary };

  ctx.varMeta.forEach(({ playerId }, varName) => {
    const { salary } = ctx.playersById.get(playerId);
    model.variables[varName].salary = salary;
    model.variables[varName].minSalary = salary;
  });
}
