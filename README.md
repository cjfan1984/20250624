# Lemon Image Factory — Ozon 图片抓取流水线（免费版）

这是一条围绕真实工作设计的自动流水线，不是展示型 Dashboard。

## 工作方式

1. 在 GitHub 仓库创建一条标题以 `OZON:` 开头的 Issue，并在正文粘贴商品链接。
2. GitHub Actions 自动连接 Browserless 云端浏览器。
3. 浏览器打开商品页并提取标题、价格文本和商品图片 URL。
4. 结果自动回复在该 Issue，并保存为工作流 Artifact。
5. ChatGPT 读取结果后继续做图片下载、竞品拆解和中文 8 图方案。

## 免费组合

- Browserless Free：远程浏览器，当前免费额度为每月 1,000 units；
- GitHub Actions：本仓库自动执行抓取任务；
- ChatGPT：负责分析、审图、文案和后续图片流水线；
- 第一阶段不调用 OpenAI API，因此没有额外 API 费用。

## 首次设置（只做一次）

1. 注册 Browserless 免费账号并复制 API Token。
2. 打开本仓库：`Settings → Secrets and variables → Actions`。
3. 点击 `New repository secret`。
4. Name 填：`BROWSERLESS_TOKEN`。
5. Secret 粘贴 Browserless Token 并保存。

不要把 Token 写进 Issue、README 或聊天内容。

## 使用

创建 Issue：

- 标题：`OZON: 抓取商品图片`
- 正文：粘贴一个完整 Ozon 商品链接

任务完成后，机器人会把提取结果回复到 Issue。