# -*- coding: utf-8 -*-
import io

path = "analytics.rs"
src = io.open(path, encoding="utf-8").read()

# 1) 在 payload 组装前预计算按项目排行
anchor = '        for (day, agents_of_day) in &daily_agent {'
assert anchor in src, "precompute anchor not found"
precompute = """        // 分项目速率排行（降序，前 8）：serde_json::json! 宏内无法写泛型参数，
        // 在宏外预计算为 Value 数组
        let rate15_rows: Vec<serde_json::Value> = {
            let mut rows: Vec<(String, i64)> = recent15_by_project.into_iter().collect();
            rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            rows.into_iter().take(8)
                .map(|(name, tokens)| serde_json::json!({ "name": name, "tokens": tokens }))
                .collect()
        };
        let rate60_rows: Vec<serde_json::Value> = {
            let mut rows: Vec<(String, i64)> = recent60_by_project.into_iter().collect();
            rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            rows.into_iter().take(8)
                .map(|(name, tokens)| serde_json::json!({ "name": name, "tokens": tokens }))
                .collect()
        };

"""
src = src.replace(anchor, precompute + anchor, 1)

# 2) json! 内改为引用预计算变量
old = """                    "by_project_15m": {
                        let mut rows: Vec<(String, i64)> = recent15_by_project
                            .into_iter()
                            .collect();
                        rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
                        rows.into_iter().take(8)
                            .map(|(name, tokens)| serde_json::json!({ "name": name, "tokens": tokens }))
                            .collect::<Vec<_>>()
                    },
                    "by_project_60m": {
                        let mut rows: Vec<(String, i64)> = recent60_by_project
                            .into_iter()
                            .collect();
                        rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
                        rows.into_iter().take(8)
                            .map(|(name, tokens)| serde_json::json!({ "name": name, "tokens": tokens }))
                            .collect::<Vec<_>>()
                    },"""
new = """                    "by_project_15m": rate15_rows,
                    "by_project_60m": rate60_rows,"""
assert old in src, "inline rank blocks not found"
src = src.replace(old, new, 1)

io.open(path, "w", encoding="utf-8", newline="\n").write(src)
print("precomputed rate rows wired")
