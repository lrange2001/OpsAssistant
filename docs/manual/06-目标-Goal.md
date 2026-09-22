# 目标 Goal

给会话设一个长期目标,每次请求都会注入给模型,让它跨轮次持续推进:

```
/goal 把这个项目的测试全部修到通过
/goal            查看当前目标
/goal pause      暂停(不再注入)
/goal resume     恢复
/goal clear      清除
/goal replace 新目标
```

设置后顶栏出现绿色 goal 徽章,点击查看;状态浮层里可暂停/恢复/清除。

